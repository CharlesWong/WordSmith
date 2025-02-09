# WriteWell - AI Writing Enhancement Extension

WriteWell is a browser extension that provides real-time writing suggestions to improve your grammar, style, and tone using AI. It integrates with Ollama to provide context-aware writing improvements directly in your browser.

## Features

- **Real-time Analysis**: Get instant feedback as you type
- **Multiple Improvement Categories**:
  - Grammar corrections
  - Style enhancements (formal, academic, casual, creative)
  - Tone adjustments (neutral, friendly, assertive, empathetic)
- **Context-Aware Suggestions**: Maintains consistency with your chosen writing style and tone
- **Easy Integration**: Works with any text input field or contenteditable element
- **Non-Intrusive UI**: Suggestions appear in a floating box that doesn't interfere with your writing

## Prerequisites

- [Ollama](https://ollama.ai/) installed and running locally
- A compatible browser (Chrome, Firefox, Edge)
- Llama2 model installed (`ollama pull llama2`)

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/writewell.git
   ```

2. Load the extension in your browser:
   - Chrome/Edge:
     1. Go to `chrome://extensions/`
     2. Enable "Developer mode"
     3. Click "Load unpacked"
     4. Select the `genai/prettify_words` directory

3. Ensure Ollama is running:
   ```bash
   ollama serve
   ```

## Usage

1. Click the WriteWell icon in your browser to configure:
   - Writing Style (formal, academic, casual, creative)
   - Tone (neutral, friendly, assertive, empathetic)

2. Start typing in any text input field on any website
3. A suggestion circle will appear when improvements are available
4. Hover over the circle to see detailed suggestions
5. Click "Apply" to implement a suggestion

## Configuration

The extension connects to Ollama at `http://localhost:11434` by default. You can modify this in the settings if needed.

## Project Structure

```
prettify_words/
├── manifest.json        # Extension configuration
├── background.js       # Handles Ollama communication
├── content.js         # UI and text processing
└── popup/            # Settings interface
    ├── popup.html
    ├── popup.css
    └── popup.js
```

## Development

The extension is built with vanilla JavaScript and uses the following components:
- `background.js`: Handles communication with Ollama, manages settings, and processes text analysis
- `content.js`: Manages the UI, text input monitoring, and suggestion display
- `popup/`: Contains the settings interface for style and tone preferences

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Ollama](https://ollama.ai/)
- Inspired by tools like Grammarly and ProWritingAid 