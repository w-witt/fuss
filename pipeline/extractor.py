"""PDF to Mathpix Markdown extraction using Nougat Python API with MPS support."""

import os
import logging
from pathlib import Path

import torch

logger = logging.getLogger(__name__)

# Cache the model globally so it's only loaded once
_nougat_model = None


def extract_mmd(pdf_path: str, output_dir: str) -> str:
    """Extract Mathpix Markdown from a PDF file.

    Tries Nougat (with MPS acceleration on Apple Silicon) first.
    Falls back to pymupdf4llm if Nougat is unavailable or fails.

    Returns the path to the generated .mmd file.
    """
    os.makedirs(output_dir, exist_ok=True)
    basename = os.path.splitext(os.path.basename(pdf_path))[0]
    mmd_path = os.path.join(output_dir, basename + '.mmd')

    try:
        return _extract_with_nougat(pdf_path, mmd_path)
    except Exception as e:
        logger.warning("Nougat extraction failed: %s. Falling back to pymupdf4llm.", e)
        return _extract_with_pymupdf(pdf_path, mmd_path)


def _get_device():
    """Select the best available device."""
    if torch.cuda.is_available():
        return torch.device('cuda')
    if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        return torch.device('mps')
    return torch.device('cpu')


def _get_nougat_model():
    """Load or return cached Nougat model."""
    global _nougat_model
    if _nougat_model is not None:
        return _nougat_model

    from nougat import NougatModel
    from nougat.utils.checkpoint import get_checkpoint

    device = _get_device()
    logger.info("Loading Nougat model on device: %s", device)

    # Use nougat's own checkpoint format (different from HuggingFace)
    checkpoint_path = get_checkpoint(model_tag='0.1.0-base')
    model = NougatModel.from_pretrained(str(checkpoint_path))
    model = model.float()
    model = model.to(device)
    model.eval()

    _nougat_model = model
    return model


def _extract_with_nougat(pdf_path: str, mmd_path: str) -> str:
    """Use the Nougat Python API with MPS/CUDA/CPU to extract MMD."""
    from nougat.utils.dataset import LazyDataset
    from torch.utils.data import DataLoader
    from nougat.postprocessing import markdown_compatible

    model = _get_nougat_model()
    device = next(model.parameters()).device

    dataset = LazyDataset(pdf_path, model.encoder.prepare_input)
    dataloader = DataLoader(dataset, batch_size=1, shuffle=False)

    all_pages = []
    for i, (sample, name) in enumerate(dataloader):
        logger.info("Processing page %d / %d...", i + 1, len(dataset))
        sample = sample.to(dtype=torch.float32, device=device)

        with torch.no_grad():
            # model.inference() hardcodes .to(bfloat16) which breaks on
            # MPS/CPU with old timm. Run encoder + decoder manually.
            output = _run_nougat_inference(model, sample)

        for page_text in output['predictions']:
            page_text = markdown_compatible(page_text)
            all_pages.append(page_text)

        # name is a tuple like ('',) for non-last pages,
        # or ('path/to/file.pdf',) for the last page
        if name and name[0]:
            break

    mmd_content = '\n\n'.join(all_pages)

    with open(mmd_path, 'w', encoding='utf-8') as f:
        f.write(mmd_content)

    if not mmd_content.strip():
        raise ValueError("Nougat produced empty output")

    logger.info("Nougat extracted %d pages to %s", len(all_pages), mmd_path)
    return mmd_path


def _run_nougat_inference(model, image_tensors):
    """Run nougat inference without the hardcoded BFloat16 cast."""
    from transformers.modeling_outputs import ModelOutput

    last_hidden_state = model.encoder(image_tensors)
    encoder_outputs = ModelOutput(last_hidden_state=last_hidden_state, attentions=None)

    if len(encoder_outputs.last_hidden_state.size()) == 1:
        encoder_outputs.last_hidden_state = encoder_outputs.last_hidden_state.unsqueeze(0)

    decoder_output = model.decoder.model.generate(
        encoder_outputs=encoder_outputs,
        min_length=1,
        max_length=model.config.max_length,
        pad_token_id=model.decoder.tokenizer.pad_token_id,
        eos_token_id=model.decoder.tokenizer.eos_token_id,
        use_cache=True,
        bad_words_ids=[
            [model.decoder.tokenizer.unk_token_id],
        ],
        return_dict_in_generate=True,
        output_scores=True,
    )

    predictions = model.decoder.tokenizer.batch_decode(
        decoder_output.sequences, skip_special_tokens=True
    )

    return {"predictions": predictions, "sequences": decoder_output.sequences}


def _extract_with_pymupdf(pdf_path: str, mmd_path: str) -> str:
    """Fallback: extract markdown from PDF using pymupdf4llm."""
    import pymupdf4llm

    md_text = pymupdf4llm.to_markdown(pdf_path)
    with open(mmd_path, 'w', encoding='utf-8') as f:
        f.write(md_text)

    return mmd_path
