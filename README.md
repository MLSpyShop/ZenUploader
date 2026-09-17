# ZenUploader

ZenUploader is an AI-assisted uploader for Zenodo that turns research PDFs into ready-to-submit metadata records. It combines PDF parsing, OCR, Gemini-based extraction, and Zenodo submission workflows to help researchers and teams speed up dataset publication.

## Live links

- Repository: https://github.com/MLSpyShop/ZenUploader
- Project index: https://mlspyshop.github.io/ZenUploader/

## What it does

- Uploads PDF files and analyzes them for publication metadata
- Extracts fields such as title, authors, abstract, keywords, and related details
- Uses AI to infer missing metadata and improve submission quality
- Supports Google Drive integration for file access and storage workflows
- Stores upload history and author profile data for repeat use
- Helps users prepare Zenodo submissions with less manual effort

## Features

- AI-powered document understanding with Gemini
- PDF text extraction and OCR support
- Zenodo API integration for metadata submission
- Firebase authentication and persistent application state
- User-friendly uploader UI with support assistant
- Built with React, Vite, TypeScript, and Express

## Tech stack

- Frontend: React + TypeScript + Vite
- Styling: Tailwind CSS
- Backend: Node.js + Express
- AI: Google Gemini
- Storage/Auth: Firebase
- Publishing API: Zenodo

## Getting started

### 1. Clone the repository

```bash
git clone https://github.com/MLSpyShop/ZenUploader.git
cd ZenUploader
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy the example environment file and fill in the required values:

```bash
cp .env.example .env
```

Required variables:

- `GEMINI_API_KEY`
- `VITE_GEMINI_API_KEY`
- `APP_URL`
- `ZENODO_API_KEY`

See `.env.example` for the expected values and comments.

### 4. Run the app

```bash
npm run dev
```

This will start the app locally for development.

### 5. Production build

```bash
npm run build
npm run start
```

## Project structure

```text
.
├── .env.example
├── .github/
├── assets/
├── public/
├── src/
├── index.html
├── metadata.json
├── package.json
├── server.ts
├── tsconfig.json
├── vite.config.ts
├── firestore.rules
└── firebase-*.json
```

## Notes

This project is designed for use in an AI Studio or web app environment where runtime secrets and app URLs are supplied automatically. The UI is intended to help researchers prepare and submit Zenodo records efficiently while keeping metadata consistent and reusable.

## License

This project does not currently declare a license in the repository metadata.
