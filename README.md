# Fuss

Fuss reads academic papers aloud. Upload a PDF and it converts the document (including mathematical notation) to spoken audio with the Nougat model, then presents an e-reader view of the PDF that highlights each word — math included — as it is read.

Named after [Nikolaus Fuss](https://en.wikipedia.org/wiki/Nicolas_Fuss) (1755–1826), the mathematician who served as Leonhard Euler's scribe, turning Euler's spoken mathematics into the written page. This tool does the reverse.

## Setup

1. Create a virtual environment:

   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows, use: venv\Scripts\activate
   ```

1. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

## Usage

### Web Interface

Run the web application:

```bash
python app.py
```

Then open your browser and navigate to `http://localhost:5050`

### Command Line Interface

To convert a PDF file using the command line:

```bash
python cli.py --input path/to/your/file.pdf --output output.tex
```

## Features

- PDF to audio with math notation read aloud, via Nougat OCR and TTS
- E-reader interface: the PDF itself is the reading surface, with word-by-word read-along highlighting
- Click any word on the page to start reading from it
- Playback speed control, segment skipping, keyboard shortcuts
- Command-line interface for batch processing

## Beta feedback

How LaTeX commands become spoken text is built in the open — the dictionary lives in [pipeline/replacements.py](pipeline/replacements.py), and reports from readers drive it. The **Feedback** button in the reader captures what was being read (word, passage, page, timestamp) and lets you report:

- LaTeX commands that were missed or read as gibberish
- words or notation pronounced incorrectly
- anything else

Reports can be submitted in-app (stored in `feedback/feedback.jsonl` on the server) or opened directly as a prefilled [GitHub issue](https://github.com/w-witt/fuss/issues/new/choose).

## License

Fuss is licensed under the [GNU General Public License v3.0](LICENSE). Parts of the text processing pipeline are adapted from [paper2speech](https://github.com/kaieberl/paper2speech) (GPL-3.0).
