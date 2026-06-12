import torch
from transformers import AutoModelForVision2Seq, AutoProcessor
from PIL import Image
import pypdf
import io
import numpy as np

class NougatWrapper:
    def __init__(self, device=None):
        if device is None:
            device = "mps" if hasattr(torch.backends, "mps") and torch.backends.mps.is_available() else "cpu"
        
        self.device = device
        self.model = AutoModelForVision2Seq.from_pretrained(
            "facebook/nougat-base",
            trust_remote_code=True,
            device_map=device,
            low_cpu_mem_usage=True
        )
        self.processor = AutoProcessor.from_pretrained("facebook/nougat-base")
        self.model.eval()

    def convert_pdf_to_images(self, pdf_path):
        """Convert PDF pages to PIL Images."""
        images = []
        with open(pdf_path, 'rb') as file:
            pdf = pypdf.PdfReader(file)
            for page in pdf.pages:
                if '/XObject' in page['/Resources']:
                    x_objects = page['/Resources']['/XObject'].get_object()
                    for obj in x_objects:
                        if x_objects[obj]['/Subtype'] == '/Image':
                            image = x_objects[obj]
                            if '/Filter' in image:
                                if image['/Filter'] == '/DCTDecode':
                                    img_data = image._data
                                    img = Image.open(io.BytesIO(img_data))
                                    images.append(img)
                                elif image['/Filter'] == '/FlateDecode':
                                    width = image['/Width']
                                    height = image['/Height']
                                    color_space = image['/ColorSpace']
                                    if color_space == '/DeviceRGB':
                                        mode = "RGB"
                                    else:
                                        mode = "L"
                                    img_data = image._data
                                    img = Image.frombytes(mode, (width, height), img_data)
                                    images.append(img)
        return images

    def process_image(self, image):
        """Process a single image through the model."""
        pixel_values = self.processor(image, return_tensors="pt").pixel_values
        pixel_values = pixel_values.to(self.device)

        with torch.no_grad():
            generated_ids = self.model.generate(
                pixel_values,
                max_length=2048,
                num_beams=4,
                early_stopping=True,
                no_repeat_ngram_size=3,
                length_penalty=2.0,
            )

        generated_text = self.processor.batch_decode(
            generated_ids, skip_special_tokens=True
        )[0]
        return generated_text

    def convert_to_latex(self, pdf_path):
        """Convert PDF to LaTeX."""
        images = self.convert_pdf_to_images(pdf_path)
        latex_parts = []
        
        for img in images:
            latex_text = self.process_image(img)
            latex_parts.append(latex_text)
        
        return "\n\n".join(latex_parts) 