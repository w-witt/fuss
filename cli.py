#!/usr/bin/env python3
import argparse
from pathlib import Path
import sys
from nougat_wrapper import NougatWrapper

def convert_pdf_to_latex(input_path: str, output_path: str) -> None:
    """
    Convert a PDF file to LaTeX format using Nougat.
    
    Args:
        input_path (str): Path to the input PDF file
        output_path (str): Path where the LaTeX file will be saved
    """
    try:
        print(f"Converting {input_path} to LaTeX...")
        
        # Initialize the model
        model = NougatWrapper()
        
        # Convert PDF to LaTeX
        latex_content = model.convert_to_latex(input_path)
        
        # Save the LaTeX content to the output file
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(latex_content)
        
        print(f"Conversion complete! LaTeX file saved to: {output_path}")
                
    except Exception as e:
        print(f"Error during conversion: {str(e)}", file=sys.stderr)
        sys.exit(1)

def main():
    parser = argparse.ArgumentParser(description='Convert PDF to LaTeX using Nougat')
    parser.add_argument('--input', '-i', required=True, help='Input PDF file path')
    parser.add_argument('--output', '-o', required=True, help='Output LaTeX file path')
    
    args = parser.parse_args()
    
    # Validate input file
    if not Path(args.input).exists():
        print(f"Error: Input file '{args.input}' does not exist.", file=sys.stderr)
        sys.exit(1)
    
    # Validate input file is PDF
    if not args.input.lower().endswith('.pdf'):
        print("Error: Input file must be a PDF file.", file=sys.stderr)
        sys.exit(1)
    
    # Validate output file has .tex extension
    if not args.output.lower().endswith('.tex'):
        print("Error: Output file must have .tex extension.", file=sys.stderr)
        sys.exit(1)
    
    convert_pdf_to_latex(args.input, args.output)

if __name__ == '__main__':
    main() 