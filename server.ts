import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { fileURLToPath } from 'url';
import multer from 'multer';
import pdfParse from 'pdf-parse';

import { GoogleGenAI } from '@google/genai';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fallbackExtractPdfText(buffer: Buffer): string {
  try {
    const str = buffer.toString('binary');
    const textBlocks: string[] = [];
    const matches = str.match(/\(([^()\r\n]{3,})\)/g);
    if (matches) {
      for (const m of matches) {
        const cleaned = m.slice(1, -1).replace(/\\([0-7]{3}|[()\\nrtb])/g, ' ').trim();
        if (cleaned.length > 3 && /[a-zA-Z]{3,}/.test(cleaned)) {
          textBlocks.push(cleaned);
        }
      }
    }
    const extracted = textBlocks.join(' ').replace(/\s+/g, ' ').trim();
    return extracted.length > 50 ? extracted.substring(0, 30000) : '';
  } catch (e) {
    return '';
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  const upload = multer({ storage: multer.memoryStorage() });

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

async function fetchAuthorWhoisBio(ai: GoogleGenAI, name: string, affiliation?: string, url?: string): Promise<{ whoisBio: string; sources?: string[] }> {
  const cleanName = (name || '').trim();
  if (!cleanName || /^(OSINT Synthesis|Unknown Author|Extracted Author|Anonymous|Et Al|N\/A|Various Authors)$/i.test(cleanName)) {
    return {
      whoisBio: cleanName ? `${cleanName}${affiliation ? ` (${affiliation})` : ''}` : 'Author information not specified.'
    };
  }

  try {
    const searchPrompt = `Perform a live web search for academic author "${cleanName}"${affiliation ? `, affiliation: "${affiliation}"` : ''}${url ? `, website/URL: "${url}"` : ''}.
Write a concise, factual, and informative 3-5 sentence "author WHOIS bio" summarizing:
1. Current institutional role, title, and affiliation
2. Key research specialization, scientific fields, and notable contributions
3. Professional identity, ORCID, or online presence if available.

Return a clean professional biography.`;

    let res: any;
    try {
      res = await generateContentWithFallback(ai, {
        contents: searchPrompt,
        config: {
          tools: [{ googleSearch: {} }],
        }
      });
    } catch (searchErr) {
      console.warn(`Search-grounded WHOIS failed for ${cleanName}, trying standard generation...`);
      res = await generateContentWithFallback(ai, {
        contents: `Write a concise 2-3 sentence academic biography for author "${cleanName}"${affiliation ? `, affiliated with "${affiliation}"` : ''}. If unknown, briefly state their topic or institutional affiliation.`
      });
    }

    const bioText = res?.text ? res.text.trim() : '';
    const groundingChunks = res?.candidates?.[0]?.groundingMetadata?.groundingChunks;
    const sources: string[] = [];
    if (Array.isArray(groundingChunks)) {
      groundingChunks.forEach((chunk: any) => {
        if (chunk.web?.uri && !sources.includes(chunk.web.uri)) {
          sources.push(chunk.web.uri);
        }
      });
    }

    return {
      whoisBio: bioText || `${cleanName}${affiliation ? ` (${affiliation})` : ''}.`,
      sources: sources.slice(0, 5)
    };
  } catch (err: any) {
    console.warn(`WHOIS bio search fallback for author ${cleanName}:`, err?.message || err);
    return {
      whoisBio: `${cleanName}${affiliation ? ` (${affiliation})` : ''}`
    };
  }
}

function escapeHtml(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildZenodoDescriptionHTML(metadata: any): string {
  let html = '';

  // TL;DR Section
  if (metadata.tldr && metadata.tldr.trim()) {
    html += `<p><strong>⚡ TL;DR:</strong> ${escapeHtml(metadata.tldr.trim())}</p>\n\n`;
  }

  // Abstract
  if (metadata.abstract && metadata.abstract.trim()) {
    html += `<p><strong>Abstract:</strong> ${escapeHtml(metadata.abstract.trim())}</p>\n\n`;
  }

  // Key Takeaways & Executive Highlights
  if (Array.isArray(metadata.keyTakeaways) && metadata.keyTakeaways.length > 0) {
    html += `<h3>Key Takeaways & Executive Highlights</h3>\n<ul>\n`;
    metadata.keyTakeaways.forEach((takeaway: string) => {
      if (typeof takeaway === 'string' && takeaway.trim()) {
        html += `  <li>${escapeHtml(takeaway.trim())}</li>\n`;
      }
    });
    html += `</ul>\n\n`;
  }

  // Novelties & Scientific Breakthroughs
  if (Array.isArray(metadata.novelties) && metadata.novelties.length > 0) {
    html += `<h3>Novelties & Core Innovations</h3>\n<ul>\n`;
    metadata.novelties.forEach((nov: string) => {
      if (typeof nov === 'string' && nov.trim()) {
        html += `  <li>${escapeHtml(nov.trim())}</li>\n`;
      }
    });
    html += `</ul>\n\n`;
  } else if (typeof metadata.novelties === 'string' && metadata.novelties.trim()) {
    html += `<h3>Novelties & Core Innovations</h3>\n<p>${escapeHtml(metadata.novelties.trim())}</p>\n\n`;
  }

  // Detailed Summary
  if (metadata.summary && metadata.summary.trim()) {
    html += `<h3>Summary & Key Contributions</h3>\n<p>${escapeHtml(metadata.summary.trim())}</p>\n\n`;
  }

  // Methodology & Experimental Framework
  if (metadata.methodology && metadata.methodology.trim()) {
    html += `<h3>Methodology & Experimental Framework</h3>\n<p>${escapeHtml(metadata.methodology.trim())}</p>\n\n`;
  }

  // Datasets & Experimental Benchmarks
  if (Array.isArray(metadata.datasetsAndBenchmarks) && metadata.datasetsAndBenchmarks.length > 0) {
    html += `<h3>Datasets & Experimental Benchmarks</h3>\n<ul>\n`;
    metadata.datasetsAndBenchmarks.forEach((item: any) => {
      if (typeof item === 'string' && item.trim()) {
        html += `  <li>${escapeHtml(item.trim())}</li>\n`;
      } else if (item && item.dataset && item.result) {
        html += `  <li><strong>${escapeHtml(String(item.dataset).trim())}:</strong> ${escapeHtml(String(item.result).trim())}</li>\n`;
      }
    });
    html += `</ul>\n\n`;
  } else if (typeof metadata.datasetsAndBenchmarks === 'string' && metadata.datasetsAndBenchmarks.trim()) {
    html += `<h3>Datasets & Experimental Benchmarks</h3>\n<p>${escapeHtml(metadata.datasetsAndBenchmarks.trim())}</p>\n\n`;
  }

  // Practical Applications
  if (Array.isArray(metadata.practicalApplications) && metadata.practicalApplications.length > 0) {
    html += `<h3>Practical Applications & Industry Use Cases</h3>\n<ul>\n`;
    metadata.practicalApplications.forEach((app: string) => {
      if (typeof app === 'string' && app.trim()) {
        html += `  <li>${escapeHtml(app.trim())}</li>\n`;
      }
    });
    html += `</ul>\n\n`;
  }

  // Limitations & Future Work
  if (Array.isArray(metadata.limitationsAndFutureWork) && metadata.limitationsAndFutureWork.length > 0) {
    html += `<h3>Limitations & Future Research Directions</h3>\n<ul>\n`;
    metadata.limitationsAndFutureWork.forEach((lim: string) => {
      if (typeof lim === 'string' && lim.trim()) {
        html += `  <li>${escapeHtml(lim.trim())}</li>\n`;
      }
    });
    html += `</ul>\n\n`;
  } else if (typeof metadata.limitationsAndFutureWork === 'string' && metadata.limitationsAndFutureWork.trim()) {
    html += `<h3>Limitations & Future Research Directions</h3>\n<p>${escapeHtml(metadata.limitationsAndFutureWork.trim())}</p>\n\n`;
  }

  // Target Audience & Required Background
  if (metadata.targetAudience && metadata.targetAudience.trim()) {
    html += `<p><strong>Target Audience & Domain Area:</strong> ${escapeHtml(metadata.targetAudience.trim())}</p>\n\n`;
  }

  // Code, Data & Artifact Repositories
  if (metadata.codeAndDataLinks && metadata.codeAndDataLinks.trim()) {
    html += `<p><strong>Code, Data & Reproducibility Links:</strong> ${escapeHtml(metadata.codeAndDataLinks.trim())}</p>\n\n`;
  }

  // Detailed Glossary
  if (Array.isArray(metadata.glossary) && metadata.glossary.length > 0) {
    html += `<h3>Detailed Glossary & Technical Terms</h3>\n<dl>\n`;
    metadata.glossary.forEach((item: any) => {
      if (item && item.term && item.definition) {
        html += `  <dt><strong>${escapeHtml(String(item.term).trim())}</strong></dt>\n`;
        html += `  <dd>${escapeHtml(String(item.definition).trim())}</dd>\n`;
      }
    });
    html += `</dl>\n\n`;
  }

  // Up to 20 FAQs
  if (Array.isArray(metadata.faq) && metadata.faq.length > 0) {
    html += `<h3>Frequently Asked Questions (FAQ)</h3>\n`;
    metadata.faq.slice(0, 20).forEach((item: any, idx: number) => {
      if (item && item.question && item.answer) {
        html += `<p><strong>Q${idx + 1}: ${escapeHtml(String(item.question).trim())}</strong><br/>\n`;
        html += `A: ${escapeHtml(String(item.answer).trim())}</p>\n\n`;
      }
    });
  }

  // Author WHOIS Bios
  if (Array.isArray(metadata.authors) && metadata.authors.some((a: any) => a?.whoisBio)) {
    html += `<h3>Author WHOIS Biographies</h3>\n<ul>\n`;
    metadata.authors.forEach((a: any) => {
      if (a && a.name) {
        html += `  <li><strong>${escapeHtml(String(a.name).trim())}</strong>`;
        if (a.affiliation) html += ` (<em>${escapeHtml(String(a.affiliation).trim())}</em>)`;
        if (a.whoisBio) html += `: ${escapeHtml(String(a.whoisBio).trim())}`;
        html += `</li>\n`;
      }
    });
    html += `</ul>\n\n`;
  }

  // Long-Tail & Standard Keywords Index
  const allKeywords = [
    ...(Array.isArray(metadata.seoKeywords) ? metadata.seoKeywords : []),
    ...(Array.isArray(metadata.longTailKeywords) ? metadata.longTailKeywords : [])
  ].filter((k: any) => typeof k === 'string' && k.trim());

  if (allKeywords.length > 0) {
    html += `<p><strong>Search Index & Long-Tail Keywords:</strong> ${allKeywords.map(k => escapeHtml(k.trim())).join(', ')}</p>\n`;
  }

  if (metadata.fundingInformation) {
    html += `<p><strong>Funding & Acknowledgments:</strong> ${escapeHtml(metadata.fundingInformation.trim())}</p>\n`;
  }

  return html.trim() || `<p>${escapeHtml(metadata.title || 'Research paper upload')}</p>`;
}

function formatZenodoDate(dateStr?: any): string {
  if (!dateStr || typeof dateStr !== 'string') {
    return new Date().toISOString().split('T')[0];
  }
  const trimmed = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || /^\d{4}-\d{2}$/.test(trimmed) || /^\d{4}$/.test(trimmed)) {
    return trimmed;
  }
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }
  const yearMonthMatch = trimmed.match(/^(\d{4})-(\d{2})/);
  if (yearMonthMatch) {
    return `${yearMonthMatch[1]}-${yearMonthMatch[2]}`;
  }
  const parsed = Date.parse(trimmed);
  if (!isNaN(parsed)) {
    const d = new Date(parsed);
    if (!isNaN(d.getTime())) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }
  }
  const yearMatch = trimmed.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    return `${yearMatch[0]}-01-01`;
  }
  return new Date().toISOString().split('T')[0];
}

function sanitizeRelatedIdentifiers(rawIdentifiers: any[], codeAndDataLinks?: string): any[] {
  const validSchemes = new Set(['doi', 'isbn', 'issn', 'url', 'urn', 'handle', 'arxiv', 'pmid', 'orcid']);
  const validRelations = new Set([
    'isCitedBy', 'cites', 'isSupplementTo', 'isSupplementedBy', 'isContinuedBy',
    'continues', 'isDescribedBy', 'describes', 'hasMetadata', 'isMetadataFor',
    'isNewVersionOf', 'isPreviousVersionOf', 'isPartOf', 'hasPart', 'isReferencedBy',
    'references', 'isDocumentedBy', 'documents', 'isCompiledBy', 'compiles',
    'isVariantFormOf', 'isOriginalFormOf', 'isIdenticalTo', 'isAlternateIdentifier'
  ]);

  const results: any[] = [];
  const seen = new Set<string>();

  const list = Array.isArray(rawIdentifiers) ? [...rawIdentifiers] : [];
  if (codeAndDataLinks && typeof codeAndDataLinks === 'string' && codeAndDataLinks.trim()) {
    list.push({ identifier: codeAndDataLinks.trim(), scheme: 'url', relation: 'isSupplementTo' });
  }

  for (const item of list) {
    if (!item) continue;
    let idStr = typeof item === 'string' ? item.trim() : (item.identifier || '').trim();
    if (!idStr) continue;

    let scheme = typeof item === 'object' && item.scheme ? String(item.scheme).toLowerCase().trim() : '';
    let relation = typeof item === 'object' && item.relation ? String(item.relation).trim() : 'isSupplementTo';
    if (!validRelations.has(relation)) {
      relation = 'isSupplementTo';
    }

    if (idStr.startsWith('10.') || /^doi:/i.test(idStr) || /^https?:\/\/(dx\.)?doi\.org\//i.test(idStr)) {
      scheme = 'doi';
      idStr = idStr.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '').trim();
      if (!/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/.test(idStr)) {
        if (typeof item === 'object' && item.identifier && String(item.identifier).startsWith('http')) {
          scheme = 'url';
          idStr = String(item.identifier).trim();
        } else {
          continue;
        }
      }
    } else if (scheme === 'doi') {
      idStr = idStr.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '').trim();
      if (!/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/.test(idStr)) {
        if (idStr.startsWith('http')) {
          scheme = 'url';
        } else {
          continue;
        }
      }
    }

    if (scheme === 'arxiv' || /^arxiv:/i.test(idStr) || /^https?:\/\/arxiv\.org\//i.test(idStr)) {
      if (idStr.startsWith('http')) {
        scheme = 'url';
      } else {
        scheme = 'arxiv';
        idStr = idStr.replace(/^arxiv:/i, '').trim();
      }
    }

    if (scheme === 'url' || (!scheme && idStr.startsWith('http')) || (!scheme && idStr.includes('.'))) {
      if (!idStr.startsWith('http://') && !idStr.startsWith('https://')) {
        idStr = `https://${idStr}`;
      }
      scheme = 'url';
      if (!/^https?:\/\/[^\s]+$/.test(idStr)) {
        continue;
      }
    }

    if (!validSchemes.has(scheme)) {
      if (/^https?:\/\//i.test(idStr)) {
        scheme = 'url';
      } else {
        continue;
      }
    }

    const key = `${scheme}:${idStr}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      identifier: idStr,
      relation: relation,
      scheme: scheme
    });
  }

  return results;
}

function buildZenodoPayload(metadata: any): any {
  const richDescriptionHTML = buildZenodoDescriptionHTML(metadata) || metadata.title || 'Research paper uploaded via ZenUploader.';

  let creatorsList = metadata.authors || metadata.creators;
  if (!Array.isArray(creatorsList) || creatorsList.length === 0) {
    creatorsList = [{ name: 'Unknown Author' }];
  }

  const zenodoCreators = creatorsList.map((a: any) => {
    const nameStr = typeof a === 'string' ? a : (a?.name || 'Unknown Author');
    const creatorObj: any = { name: nameStr.trim() || 'Unknown Author' };
    if (a && typeof a === 'object') {
      if (a.affiliation && typeof a.affiliation === 'string' && a.affiliation.trim()) {
        creatorObj.affiliation = a.affiliation.trim();
      }
      if (a.orcid && typeof a.orcid === 'string') {
        let cleanOrcid = a.orcid.replace(/^https?:\/\/orcid\.org\//i, '').replace(/[^0-9X]/gi, '').trim().toUpperCase();
        if (cleanOrcid.length === 16) {
          cleanOrcid = `${cleanOrcid.slice(0, 4)}-${cleanOrcid.slice(4, 8)}-${cleanOrcid.slice(8, 12)}-${cleanOrcid.slice(12, 16)}`;
        }
        if (/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(cleanOrcid)) {
          creatorObj.orcid = cleanOrcid;
        }
      }
    }
    return creatorObj;
  });

  const zenodoMetadata: any = {
    title: (metadata.title || 'Untitled Research Paper').trim(),
    upload_type: "publication",
    publication_type: "article",
    description: richDescriptionHTML,
    publication_date: formatZenodoDate(metadata.publicationDate || metadata.publication_date),
    creators: zenodoCreators,
    access_right: "open"
  };

  const keywordSet = new Set<string>();
  const addKw = (k: any) => {
    if (typeof k === 'string') {
      const cleaned = k.replace(/[\r\n\t]/g, ' ').trim();
      if (cleaned.length > 0 && cleaned.length < 100) {
        keywordSet.add(cleaned);
      }
    }
  };
  if (Array.isArray(metadata.seoKeywords)) metadata.seoKeywords.forEach(addKw);
  if (Array.isArray(metadata.longTailKeywords)) metadata.longTailKeywords.forEach(addKw);
  if (Array.isArray(metadata.keywords)) metadata.keywords.forEach(addKw);
  if (keywordSet.size > 0) {
    zenodoMetadata.keywords = Array.from(keywordSet);
  }

  if (metadata.fundingInformation && typeof metadata.fundingInformation === 'string' && metadata.fundingInformation.trim()) {
    zenodoMetadata.notes = `Funding & Support: ${metadata.fundingInformation.trim()}`;
  }

  if (metadata.references && Array.isArray(metadata.references) && metadata.references.length > 0) {
    const refs = metadata.references.map((r: any) => {
      if (typeof r === 'string') return r.replace(/[\r\n]/g, ' ').trim();
      if (r && typeof r === 'object') {
        return `${r.name || r.title || ''}${r.url ? ` (${r.url})` : ''}`.replace(/[\r\n]/g, ' ').trim();
      }
      return '';
    }).filter(Boolean);
    if (refs.length > 0) {
      zenodoMetadata.references = refs;
    }
  }

  if (metadata.journalName && typeof metadata.journalName === 'string' && metadata.journalName.trim()) {
    zenodoMetadata.journal_title = metadata.journalName.trim();
  }

  const cleanedRelatedIds = sanitizeRelatedIdentifiers(metadata.identifiers, metadata.codeAndDataLinks);
  if (cleanedRelatedIds.length > 0) {
    zenodoMetadata.related_identifiers = cleanedRelatedIds;
  }

  return zenodoMetadata;
}

const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-2.5-pro',
  'gemini-flash-latest',
  'gemini-3.6-flash'
];

async function generateContentWithFallback(ai: GoogleGenAI, request: { contents: any, config?: any }): Promise<any> {
  let lastErr: any = null;
  for (const modelName of GEMINI_MODELS) {
    let retries = 0;
    const MAX_RETRIES = 2;
    while (retries < MAX_RETRIES) {
      try {
        console.log(`DEBUG: Calling Gemini model ${modelName} (attempt ${retries + 1})...`);
        const result = await ai.models.generateContent({
          model: modelName,
          contents: request.contents,
          config: request.config
        });
        if (result) return result;
      } catch (err: any) {
        lastErr = err;
        const status = err.status || err.statusCode;
        const msg = typeof err.message === 'string' ? err.message : JSON.stringify(err);
        
        const isInvalidKey = status === 401 || (msg && (
          msg.includes('401') ||
          msg.includes('API_KEY_INVALID') ||
          msg.includes('API key not valid') ||
          msg.includes('UNAUTHENTICATED') ||
          msg.includes('ACCESS_TOKEN_TYPE_UNSUPPORTED') ||
          msg.includes('API_KEY_SERVICE_BLOCKED')
        ));

        if (isInvalidKey) {
          throw new Error('Invalid or unauthorized Gemini API key. Please verify your Gemini API key in Settings or the API key input.');
        }

        const isTransient = status === 503 || status === 429 || (msg && (
          msg.includes('503') ||
          msg.includes('429') ||
          msg.includes('RESOURCE_EXHAUSTED') ||
          msg.includes('quota') ||
          msg.includes('rate limit') ||
          msg.includes('UNAVAILABLE') ||
          msg.includes('overloaded')
        ));
        if (isTransient && retries < MAX_RETRIES - 1) {
          retries++;
          await new Promise(resolve => setTimeout(resolve, 1000 * retries));
        } else {
          console.log(`DEBUG: Model ${modelName} failed (${msg.substring(0, 100)}), trying next model...`);
          break;
        }
      }
    }
  }
  throw lastErr || new Error('All Gemini model attempts failed.');
}

function parseMetadataFromPdfText(text: string, filename: string = ''): any {
  const cleanText = text.replace(/\r\n/g, '\n').trim();
  const lines = cleanText.split('\n').map(l => l.trim()).filter(Boolean);
  
  // 1. Title Extraction
  let title = '';
  if (lines.length > 0) {
    const candidateLines = lines.slice(0, 5).filter(l => !/^page\s+\d+/i.test(l) && l.length > 5);
    if (candidateLines.length > 0) {
      title = candidateLines.slice(0, 2).join(' ');
    }
  }
  if (!title && filename) {
    title = filename.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');
  }
  if (title.length > 250) {
    title = title.substring(0, 250);
  }

  // 2. Abstract Extraction
  let abstract = '';
  const abstractMatch = cleanText.match(/(?:abstract|summary)[\s:-]+([\s\S]{50,2000}?)(?=\n\s*(?:1[\s.]+|introduction|keywords|index terms|1\.\s+introduction)|$)/i);
  if (abstractMatch) {
    abstract = abstractMatch[1].replace(/[\r\n]+/g, ' ').trim();
  }

  // 3. Keywords Extraction
  const keywords: string[] = [];
  const kwMatch = cleanText.match(/(?:keywords|index terms|key words)[\s:-]+([^\n\r]{5,200})/i);
  if (kwMatch) {
    kwMatch[1].split(/[,;•|]/).forEach(k => {
      const cleaned = k.trim();
      if (cleaned && cleaned.length > 1 && cleaned.length < 60) {
        keywords.push(cleaned);
      }
    });
  }

  // 4. Authors Extraction
  const authors: any[] = [];
  if (lines.length > 2) {
    const authorSection = lines.slice(1, 10).join(' ');
    const potentialNames = authorSection.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}/g);
    if (potentialNames && potentialNames.length > 0) {
      const uniqueNames = Array.from(new Set(potentialNames)).slice(0, 6);
      uniqueNames.forEach(name => {
        if (!/Abstract|Introduction|University|Department|IEEE|ACM|Springer|arxiv/i.test(name)) {
          authors.push({ name });
        }
      });
    }
  }
  if (authors.length === 0) {
    authors.push({ name: 'Extracted Author' });
  }

  // 5. Code and Data Links
  const linkMatches = cleanText.match(/https?:\/\/(?:github\.com|gitlab\.com|huggingface\.co|zenodo\.org|doi\.org)\/[^\s()<>,]+/gi);
  const codeLinks = linkMatches ? Array.from(new Set(linkMatches)).join(', ') : '';

  // 6. DOI or Identifiers
  const doiMatch = cleanText.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/);
  const identifiers = doiMatch ? [{ identifier: doiMatch[0], scheme: 'doi' }] : [];

  // 7. References
  const references: any[] = [];
  const refSectionMatch = cleanText.match(/(?:references|bibliography)[\s:-]+([\s\S]{100,5000})/i);
  if (refSectionMatch) {
    const refLines = refSectionMatch[1].split(/\n+/).map(l => l.trim()).filter(l => l.length > 15);
    refLines.slice(0, 10).forEach(ref => {
      references.push({ name: ref.replace(/^\[\d+\]\s*/, '') });
    });
  }

  // 8. Publication Date
  const yearMatch = cleanText.match(/\b(19\d\d|20\d\d)\b/);
  const pubDate = yearMatch ? yearMatch[0] : new Date().toISOString().split('T')[0];

  return {
    title: title || 'Research Paper',
    alternativeTitle: '',
    authors,
    publicationDate: pubDate,
    fundingInformation: '',
    tldr: abstract ? abstract.substring(0, 180) + '...' : 'Metadata extracted directly from PDF text.',
    abstract: abstract || 'Abstract extracted from uploaded PDF.',
    summary: abstract || 'Summary extracted from uploaded PDF.',
    keyTakeaways: [
      'Document processed via PDF text parser.',
      'Full text available for search and indexing.'
    ],
    novelties: [
      'Parsed directly from PDF document content.'
    ],
    glossary: [],
    faq: [],
    longTailKeywords: keywords.length > 0 ? keywords : ['research paper', 'pdf document'],
    datasetsAndBenchmarks: [],
    practicalApplications: [],
    methodology: '',
    limitationsAndFutureWork: [],
    targetAudience: '',
    codeAndDataLinks: codeLinks,
    seoDescription: (title || 'Research paper').substring(0, 160),
    seoKeywords: keywords.length > 0 ? keywords : ['research', 'publication', 'paper'],
    subjects: ['Multidisciplinary'],
    identifiers,
    references,
    license: '',
    journalName: '',
    notice: 'Note: Gemini AI key was missing or invalid, so basic metadata was extracted directly from the PDF text. Enter a valid Gemini API key in Settings above to enable AI rich summaries, glossaries, and WHOIS bio lookups.'
  };
}

  app.post('/api/process-pdf', upload.single('pdf'), async (req, res) => {
    const file = (req as any).file;
    if (!file) {
      return res.status(400).send('No file uploaded.');
    }
    try {
      if (!file || !file.buffer) {
        throw new Error('No file buffer found');
      }
      
      if (!file.buffer.slice(0, 5).toString('ascii').startsWith('%PDF-')) {
        throw new Error('Not a valid PDF file: File header does not start with %PDF-');
      }
      
      console.log('DEBUG: Preparing PDF for processing...');
      console.log('DEBUG: File size:', file.buffer.length, 'bytes');

      let extractedText = '';
      try {
        const parsedPdf = await pdfParse(file.buffer);
        if (parsedPdf && parsedPdf.text && parsedPdf.text.trim().length > 30) {
          extractedText = parsedPdf.text.trim().substring(0, 40000);
          console.log('DEBUG: Extracted text from PDF using pdf-parse, length:', extractedText.length);
        }
      } catch (pdfErr: any) {
        console.warn('DEBUG: pdf-parse failed:', pdfErr?.message || pdfErr);
      }

      if (!extractedText) {
        extractedText = fallbackExtractPdfText(file.buffer);
        if (extractedText) {
          console.log('DEBUG: Extracted text from PDF using fallback parser, length:', extractedText.length);
        }
      }
      
      const rawApiKey = (req.body && req.body.geminiApiKey) || (req.header('X-Gemini-Api-Key') as string) || (req.headers['x-gemini-api-key'] as string) || process.env.GEMINI_API_KEY || '';
      const apiKey = rawApiKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();

      let metadata: any = null;

      if (apiKey) {
        try {
          const ai = new GoogleGenAI({ apiKey });
          const prompt = `Extract comprehensive metadata, detailed domain analysis, and rich indexing attributes from this research paper as a JSON object with these fields:
title: primary title of the paper,
alternativeTitle: translated or secondary title if any,
authors: array of objects with 'name', 'affiliation', and 'url' (ORCID, scholar, or website if available),
publicationDate: publication date or year,
fundingInformation: grants, funding bodies, or support,
tldr: ultra-concise 1-2 sentence executive punchline summarizing the paper's single most significant result or breakthrough,
abstract: original or extracted abstract,
summary: detailed summary of key findings and contributions,
keyTakeaways: array of 3-5 punchy executive bullet points summarizing high-level takeaways for busy readers,
novelties: array of 4-8 distinct bullet strings highlighting exactly what is novel in this paper (scientific innovations, original algorithms/methods, performance gains, or breakthroughs),
glossary: array of objects, each with 'term' (technical, domain-specific, method, or key concept term from the paper) and 'definition' (clear, comprehensive explanation of what this term means in the context of this paper). Provide a complete, detailed glossary containing at least 8-15 key terms,
faq: array of objects, each with 'question' and 'answer' fields covering top questions answered by the paper. Provide up to 20 comprehensive questions and detailed answers (covering methodology, experimental setup, datasets, performance benchmarks, limitations, comparison with prior art, and real-world practical applications),
longTailKeywords: array of 15-25 specific multi-word long-tail search phrases (e.g., "zero-shot vision-language model for medical imagery classification", "high-throughput genomic variance pipeline"),
datasetsAndBenchmarks: array of objects or strings detailing datasets used, baseline comparisons, and quantitative benchmarks (e.g. accuracy gains, speedups, metrics),
practicalApplications: array of 3-6 real-world practical applications or industry/scientific deployment scenarios,
methodology: concise overview of core algorithms, architectures, datasets, and experimental frameworks used,
limitationsAndFutureWork: array of 3-6 bullet points covering paper caveats, assumptions, failure modes, and future research directions,
targetAudience: target audience, domain specialization, or prerequisite knowledge required,
codeAndDataLinks: repository links, code/dataset URLs, or availability details mentioned in the paper,
seoDescription: max 160 characters summary for search engines,
seoKeywords: array of at least 20 relevant standard keywords,
subjects: array of subject domains,
identifiers: array of objects with 'identifier' and 'scheme' fields,
references: array of objects with 'name' and 'url' fields,
license: license if mentioned,
journalName: journal or conference name.

If a field is not found, use an empty string or empty array as appropriate.
Return ONLY valid JSON.`;

          const parts: any[] = [{ text: prompt }];
          if (extractedText) {
            parts.push({ text: `Research Paper Text:\n\n${extractedText}` });
          } else {
            parts.push({ inlineData: { data: file.buffer.toString('base64'), mimeType: 'application/pdf' } });
          }

          console.log('DEBUG: Attempting Gemini AI extraction...');
          const result = await generateContentWithFallback(ai, {
            contents: [{ role: 'user', parts }],
            config: { responseMimeType: "application/json" }
          });

          let rawText = result.text || '';
          const startIndex = rawText.indexOf('{');
          const endIndex = rawText.lastIndexOf('}');
          if (startIndex !== -1 && endIndex !== -1) {
            rawText = rawText.substring(startIndex, endIndex + 1);
            metadata = JSON.parse(rawText);
          }
        } catch (aiErr: any) {
          console.warn('DEBUG: Gemini AI metadata extraction failed:', aiErr?.message || aiErr);
        }
      }

      if (!metadata) {
        console.log('DEBUG: Fallback to PDF text parser metadata extraction...');
        metadata = parseMetadataFromPdfText(extractedText, file.originalname || 'paper.pdf');
      } else {
        // Enrich authors if AI succeeded
        if (Array.isArray(metadata.authors) && metadata.authors.length > 0) {
          try {
            const ai = new GoogleGenAI({ apiKey });
            const enrichedAuthors = await Promise.all(
              metadata.authors.slice(0, 4).map(async (author: any) => {
                const name = typeof author === 'string' ? author : author?.name;
                const affiliation = typeof author === 'object' ? author?.affiliation : '';
                const url = typeof author === 'object' ? author?.url : '';
                if (name && name.trim() && name !== 'Unknown Author') {
                  const whois = await fetchAuthorWhoisBio(ai, name, affiliation, url);
                  return {
                    name: name.trim(),
                    affiliation: affiliation || '',
                    url: url || '',
                    whoisBio: whois.whoisBio,
                    whoisSources: whois.sources || []
                  };
                }
                return typeof author === 'object' ? author : { name: name || 'Unknown Author' };
              })
            );
            if (metadata.authors.length > 4) {
              for (let i = 4; i < metadata.authors.length; i++) {
                const a = metadata.authors[i];
                enrichedAuthors.push(typeof a === 'object' ? a : { name: String(a) });
              }
            }
            metadata.authors = enrichedAuthors;
          } catch (err) {
            console.warn('Author WHOIS enrichment skipped:', err);
          }
        }
      }

      res.json(metadata);
    } catch (error: any) {
      console.error('Error in processing PDF:', error);
      let msg = error.message || (typeof error === 'string' ? error : 'An unexpected error occurred while processing the PDF.');
      if (msg.includes('API_KEY_INVALID') || msg.includes('API key not valid')) {
        msg = 'Invalid or unauthorized Gemini API key. Please check your Gemini API key in Settings or the API key input.';
        return res.status(401).send(msg);
      }
      if (msg.toLowerCase().includes('load failed')) {
        msg = 'Unable to load PDF content. Please ensure the file is an unencrypted, valid PDF document.';
      }
      res.status(500).send(msg);
    }
  });

  app.post('/api/author-whois', async (req, res) => {
    try {
      const { name, affiliation, url, geminiApiKey } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'Author name is required.' });
      }

      const rawApiKey = geminiApiKey || (req.header('X-Gemini-Api-Key') as string) || (req.headers['x-gemini-api-key'] as string) || process.env.GEMINI_API_KEY || '';
      const apiKey = rawApiKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();
      if (!apiKey) {
        return res.status(401).send('Gemini API key is required for live author WHOIS search.');
      }

      const ai = new GoogleGenAI({ apiKey });
      const result = await fetchAuthorWhoisBio(ai, name, affiliation, url);
      res.json(result);
    } catch (err: any) {
      console.error('Error in /api/author-whois:', err);
      res.status(500).send(err.message || 'Failed to fetch author WHOIS bio.');
    }
  });

  app.post('/api/generate-glossary', async (req, res) => {
    try {
      const { title, abstract, summary, text, geminiApiKey } = req.body;
      const rawApiKey = geminiApiKey || (req.header('X-Gemini-Api-Key') as string) || (req.headers['x-gemini-api-key'] as string) || process.env.GEMINI_API_KEY || '';
      const apiKey = rawApiKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();
      if (!apiKey) {
        return res.status(401).send('Gemini API key is required.');
      }

      const ai = new GoogleGenAI({ apiKey });
      const contextPrompt = `Generate a complete, detailed glossary for a research paper based on the following details:
Title: ${title || 'N/A'}
Abstract: ${abstract || 'N/A'}
Summary: ${summary || 'N/A'}
Text snippet: ${text ? text.substring(0, 8000) : 'N/A'}

Return a JSON array of objects, where each object has:
- 'term': technical, domain-specific term, key concept, method, or acronym
- 'definition': clear, comprehensive 1-3 sentence definition explaining its exact meaning in the context of this paper.
Provide a complete, detailed glossary with at least 8 to 15 terms.
Return ONLY valid JSON array.`;

      const response = await generateContentWithFallback(ai, {
        contents: contextPrompt,
        config: {
          responseMimeType: "application/json"
        }
      });

      let rawText = response.text || '[]';
      const startIndex = rawText.indexOf('[');
      const endIndex = rawText.lastIndexOf(']');
      if (startIndex !== -1 && endIndex !== -1) {
        rawText = rawText.substring(startIndex, endIndex + 1);
      }
      const glossary = JSON.parse(rawText);
      res.json({ glossary });
    } catch (err: any) {
      console.error('Error in /api/generate-glossary:', err);
      res.status(500).send(err.message || 'Failed to generate glossary');
    }
  });

  app.post('/api/generate-faq', async (req, res) => {
    try {
      const { title, abstract, summary, count, geminiApiKey } = req.body;
      const rawApiKey = geminiApiKey || (req.header('X-Gemini-Api-Key') as string) || (req.headers['x-gemini-api-key'] as string) || process.env.GEMINI_API_KEY || '';
      const apiKey = rawApiKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();
      if (!apiKey) {
        return res.status(401).send('Gemini API key is required.');
      }

      const targetCount = Math.min(20, Math.max(5, Number(count) || 20));
      const ai = new GoogleGenAI({ apiKey });
      const contextPrompt = `Generate a comprehensive FAQ list containing exactly ${targetCount} high-value questions and detailed answers for the research paper:
Title: ${title || 'N/A'}
Abstract: ${abstract || 'N/A'}
Summary: ${summary || 'N/A'}

Cover these aspects across the ${targetCount} questions:
1. Primary objective and research problem
2. What is novel in this methodology compared to prior state-of-the-art
3. Core algorithmic architecture or theoretical framework
4. Datasets, samples, or experimental setup used
5. Primary quantitative results and performance gains
6. Key limitations, assumptions, or failure modes
7. Practical, real-world industry or academic applications
8. Reproducibility, code/data availability, and future research directions.

Return a JSON array of objects, where each object has:
- 'question': clear, specific question
- 'answer': detailed 2-4 sentence explanation.
Return ONLY valid JSON array with ${targetCount} objects.`;

      const response = await generateContentWithFallback(ai, {
        contents: contextPrompt,
        config: {
          responseMimeType: "application/json"
        }
      });

      let rawText = response.text || '[]';
      const startIndex = rawText.indexOf('[');
      const endIndex = rawText.lastIndexOf(']');
      if (startIndex !== -1 && endIndex !== -1) {
        rawText = rawText.substring(startIndex, endIndex + 1);
      }
      const faq = JSON.parse(rawText);
      res.json({ faq });
    } catch (err: any) {
      console.error('Error in /api/generate-faq:', err);
      res.status(500).send(err.message || 'Failed to generate FAQs');
    }
  });

  app.post('/api/generate-tldr', async (req, res) => {
    try {
      const { title, abstract, summary, geminiApiKey } = req.body;
      const rawApiKey = geminiApiKey || (req.header('X-Gemini-Api-Key') as string) || (req.headers['x-gemini-api-key'] as string) || process.env.GEMINI_API_KEY || '';
      const apiKey = rawApiKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();
      if (!apiKey) {
        return res.status(401).send('Gemini API key is required.');
      }

      const ai = new GoogleGenAI({ apiKey });
      const contextPrompt = `Generate an ultra-concise 1 to 2 sentence TL;DR punchline summarizing the core finding and real-world impact of this research paper:
Title: ${title || 'N/A'}
Abstract: ${abstract || 'N/A'}
Summary: ${summary || 'N/A'}

Return a JSON object: { "tldr": "..." }`;

      const response = await generateContentWithFallback(ai, {
        contents: contextPrompt,
        config: {
          responseMimeType: "application/json"
        }
      });

      let rawText = response.text || '{}';
      const startIndex = rawText.indexOf('{');
      const endIndex = rawText.lastIndexOf('}');
      if (startIndex !== -1 && endIndex !== -1) {
        rawText = rawText.substring(startIndex, endIndex + 1);
      }
      const data = JSON.parse(rawText);
      res.json({ tldr: data.tldr || '' });
    } catch (err: any) {
      console.error('Error in /api/generate-tldr:', err);
      res.status(500).send(err.message || 'Failed to generate TL;DR');
    }
  });

  app.post('/api/generate-takeaways', async (req, res) => {
    try {
      const { title, abstract, summary, geminiApiKey } = req.body;
      const rawApiKey = geminiApiKey || (req.header('X-Gemini-Api-Key') as string) || (req.headers['x-gemini-api-key'] as string) || process.env.GEMINI_API_KEY || '';
      const apiKey = rawApiKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();
      if (!apiKey) {
        return res.status(401).send('Gemini API key is required.');
      }

      const ai = new GoogleGenAI({ apiKey });
      const contextPrompt = `Generate 3-5 punchy executive key takeaway bullet points for busy readers of this research paper:
Title: ${title || 'N/A'}
Abstract: ${abstract || 'N/A'}
Summary: ${summary || 'N/A'}

Return a JSON array of strings. Return ONLY valid JSON array.`;

      const response = await generateContentWithFallback(ai, {
        contents: contextPrompt,
        config: {
          responseMimeType: "application/json"
        }
      });

      let rawText = response.text || '[]';
      const startIndex = rawText.indexOf('[');
      const endIndex = rawText.lastIndexOf(']');
      if (startIndex !== -1 && endIndex !== -1) {
        rawText = rawText.substring(startIndex, endIndex + 1);
      }
      const takeaways = JSON.parse(rawText);
      res.json({ keyTakeaways: takeaways });
    } catch (err: any) {
      console.error('Error in /api/generate-takeaways:', err);
      res.status(500).send(err.message || 'Failed to generate takeaways');
    }
  });

  app.post('/api/generate-benchmarks', async (req, res) => {
    try {
      const { title, abstract, summary, geminiApiKey } = req.body;
      const rawApiKey = geminiApiKey || (req.header('X-Gemini-Api-Key') as string) || (req.headers['x-gemini-api-key'] as string) || process.env.GEMINI_API_KEY || '';
      const apiKey = rawApiKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();
      if (!apiKey) {
        return res.status(401).send('Gemini API key is required.');
      }

      const ai = new GoogleGenAI({ apiKey });
      const contextPrompt = `Extract or synthesize the primary datasets used, experimental baselines, and key quantitative benchmark numbers/results (e.g. accuracy %, speedup factor, F1 score) for this paper:
Title: ${title || 'N/A'}
Abstract: ${abstract || 'N/A'}
Summary: ${summary || 'N/A'}

Return a JSON array of bullet strings (e.g., ["Dataset: ImageNet-1k - Achieved 87.4% top-1 accuracy (+2.3% over ResNet-50 baseline)"]).
Return ONLY valid JSON array.`;

      const response = await generateContentWithFallback(ai, {
        contents: contextPrompt,
        config: {
          responseMimeType: "application/json"
        }
      });

      let rawText = response.text || '[]';
      const startIndex = rawText.indexOf('[');
      const endIndex = rawText.lastIndexOf(']');
      if (startIndex !== -1 && endIndex !== -1) {
        rawText = rawText.substring(startIndex, endIndex + 1);
      }
      const benchmarks = JSON.parse(rawText);
      res.json({ datasetsAndBenchmarks: benchmarks });
    } catch (err: any) {
      console.error('Error in /api/generate-benchmarks:', err);
      res.status(500).send(err.message || 'Failed to generate benchmarks');
    }
  });

  app.post('/api/generate-limitations', async (req, res) => {
    try {
      const { title, abstract, summary, geminiApiKey } = req.body;
      const rawApiKey = geminiApiKey || (req.header('X-Gemini-Api-Key') as string) || (req.headers['x-gemini-api-key'] as string) || process.env.GEMINI_API_KEY || '';
      const apiKey = rawApiKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();
      if (!apiKey) {
        return res.status(401).send('Gemini API key is required.');
      }

      const ai = new GoogleGenAI({ apiKey });
      const contextPrompt = `Identify 3-5 transparent scientific limitations, computational assumptions, failure cases, and open future research directions for this paper:
Title: ${title || 'N/A'}
Abstract: ${abstract || 'N/A'}
Summary: ${summary || 'N/A'}

Return a JSON array of strings. Return ONLY valid JSON array.`;

      const response = await generateContentWithFallback(ai, {
        contents: contextPrompt,
        config: {
          responseMimeType: "application/json"
        }
      });

      let rawText = response.text || '[]';
      const startIndex = rawText.indexOf('[');
      const endIndex = rawText.lastIndexOf(']');
      if (startIndex !== -1 && endIndex !== -1) {
        rawText = rawText.substring(startIndex, endIndex + 1);
      }
      const limitations = JSON.parse(rawText);
      res.json({ limitationsAndFutureWork: limitations });
    } catch (err: any) {
      console.error('Error in /api/generate-limitations:', err);
      res.status(500).send(err.message || 'Failed to generate limitations');
    }
  });

  app.post('/api/generate-novelties', async (req, res) => {
    try {
      const { title, abstract, summary, geminiApiKey } = req.body;
      const rawApiKey = geminiApiKey || (req.header('X-Gemini-Api-Key') as string) || (req.headers['x-gemini-api-key'] as string) || process.env.GEMINI_API_KEY || '';
      const apiKey = rawApiKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();
      if (!apiKey) {
        return res.status(401).send('Gemini API key is required.');
      }

      const ai = new GoogleGenAI({ apiKey });
      const contextPrompt = `Analyze this research paper and extract 5 to 8 distinct, bullet-point items outlining EXACTLY what is novel in the paper:
Title: ${title || 'N/A'}
Abstract: ${abstract || 'N/A'}
Summary: ${summary || 'N/A'}

Highlight:
- Scientific innovations and theoretical breakthroughs
- Original algorithms, architecture modifications, or methodological improvements
- First-of-their-kind benchmarks, datasets, or experimental findings
- State-of-the-art performance improvements.

Return a JSON array of strings, where each string is a clear, concise bullet point explaining a specific novelty.
Return ONLY valid JSON array.`;

      const response = await generateContentWithFallback(ai, {
        contents: contextPrompt,
        config: {
          responseMimeType: "application/json"
        }
      });

      let rawText = response.text || '[]';
      const startIndex = rawText.indexOf('[');
      const endIndex = rawText.lastIndexOf(']');
      if (startIndex !== -1 && endIndex !== -1) {
        rawText = rawText.substring(startIndex, endIndex + 1);
      }
      const novelties = JSON.parse(rawText);
      res.json({ novelties });
    } catch (err: any) {
      console.error('Error in /api/generate-novelties:', err);
      res.status(500).send(err.message || 'Failed to generate novelties');
    }
  });

  app.post('/api/generate-keywords', async (req, res) => {
    try {
      const { title, abstract, summary, geminiApiKey } = req.body;
      const rawApiKey = geminiApiKey || (req.header('X-Gemini-Api-Key') as string) || (req.headers['x-gemini-api-key'] as string) || process.env.GEMINI_API_KEY || '';
      const apiKey = rawApiKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();
      if (!apiKey) {
        return res.status(401).send('Gemini API key is required.');
      }

      const ai = new GoogleGenAI({ apiKey });
      const contextPrompt = `Generate a rich set of 20 to 30 long-tail search phrases and domain keywords for this research paper:
Title: ${title || 'N/A'}
Abstract: ${abstract || 'N/A'}
Summary: ${summary || 'N/A'}

Provide:
- Long-tail multi-word search phrases (3-6 words) that researchers would type into Google Scholar or Zenodo
- Specific methodology & architecture terms
- Dataset, domain, and application area phrases.

Return a JSON array of strings. Return ONLY valid JSON array.`;

      const response = await generateContentWithFallback(ai, {
        contents: contextPrompt,
        config: {
          responseMimeType: "application/json"
        }
      });

      let rawText = response.text || '[]';
      const startIndex = rawText.indexOf('[');
      const endIndex = rawText.lastIndexOf(']');
      if (startIndex !== -1 && endIndex !== -1) {
        rawText = rawText.substring(startIndex, endIndex + 1);
      }
      const keywords = JSON.parse(rawText);
      res.json({ keywords });
    } catch (err: any) {
      console.error('Error in /api/generate-keywords:', err);
      res.status(500).send(err.message || 'Failed to generate keywords');
    }
  });


  app.post('/api/upload-to-zenodo', upload.single('pdf'), async (req, res) => {
    console.log('DEBUG: /api/upload-to-zenodo called');
    const file = (req as any).file;
    const metadata = req.body.metadata ? JSON.parse(req.body.metadata) : null;
    
    if (!metadata || !file) {
      return res.status(400).send('No metadata or file provided.');
    }

    try {
      const rawZenodoKey = (req.body && req.body.zenodoApiKey) || (req.header('X-Zenodo-Api-Key') as string) || process.env.ZENODO_API_KEY || '';
      const ZENODO_API_KEY = rawZenodoKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();
      if (!ZENODO_API_KEY) {
        return res.status(401).send('Zenodo API Key is missing. Please enter your Zenodo API Token in Settings.');
      }
      const BASE_URL = 'https://zenodo.org/api/deposit/depositions';

      const originalName = file.originalname || 'paper.pdf';
      const safeFilename = originalName
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/["'\r\n\t]/g, '_')
        .replace(/\s+/g, '_')
        .trim() || 'paper.pdf';
      
      const zenodoMetadata = buildZenodoPayload(metadata);
      
      // 1. Create Deposition
      console.log('DEBUG: Creating Zenodo deposition with metadata:', JSON.stringify(zenodoMetadata, null, 2));
      const depResponse = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ZENODO_API_KEY}`
        },
        body: JSON.stringify({ metadata: zenodoMetadata })
      });
      
      if (!depResponse.ok) {
        const errText = await depResponse.text();
        console.error('DEBUG: Zenodo deposition creation failed:', errText);
        let detailMessage = errText;
        try {
          const parsedErr = JSON.parse(errText);
          if (parsedErr.errors && Array.isArray(parsedErr.errors) && parsedErr.errors.length > 0) {
            detailMessage = parsedErr.errors.map((e: any) => `${e.field || 'field'}: ${e.message}`).join('; ');
          } else if (parsedErr.message) {
            detailMessage = parsedErr.message;
          }
        } catch (e) {}
        throw new Error(`Zenodo Deposition creation failed: ${detailMessage}`);
      }
      
      const depData = await depResponse.json();
      const depositionId = depData.id;
      console.log('DEBUG: Deposition created successfully, ID:', depositionId);
      
      // 2. Upload File (Prefer Bucket API if available, fallback to legacy form)
      if (depData.links && depData.links.bucket) {
        const bucketUrl = `${depData.links.bucket}/${encodeURIComponent(safeFilename)}`;
        console.log('DEBUG: Uploading file via Bucket API to:', bucketUrl);
        const fileResponse = await fetch(bucketUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${ZENODO_API_KEY}`,
            'Content-Type': 'application/octet-stream'
          },
          body: file.buffer
        });
        
        if (!fileResponse.ok) {
          const errText = await fileResponse.text();
          console.error('DEBUG: Bucket file upload failed:', errText);
          throw new Error(`Zenodo File upload failed: ${errText}`);
        }
      } else {
        const fileUrl = `${BASE_URL}/${depositionId}/files`;
        const formData = new FormData();
        formData.append('file', new Blob([file.buffer], { type: 'application/octet-stream' }), safeFilename);
        
        const fileResponse = await fetch(fileUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ZENODO_API_KEY}`
          },
          body: formData
        });
        
        if (!fileResponse.ok) {
          const errText = await fileResponse.text();
          console.error('DEBUG: Legacy file upload failed:', errText);
          throw new Error(`Zenodo File upload failed: ${errText}`);
        }
      }
      
      // 3. Publish Deposition (optional step)
      let published = false;
      let publishData: any = null;
      try {
        const publishResponse = await fetch(`${BASE_URL}/${depositionId}/actions/publish`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ZENODO_API_KEY}`
          }
        });
        if (publishResponse.ok) {
          publishData = await publishResponse.json();
          published = true;
        } else {
          const errTxt = await publishResponse.text();
          console.warn('DEBUG: Zenodo publish notice (saved as draft):', errTxt);
        }
      } catch (pErr) {
        console.warn('DEBUG: Zenodo publish step skipped (saved as draft):', pErr);
      }
      
      res.json({
        message: published ? 'Upload and publication successful' : 'Upload successful (saved as draft on Zenodo)',
        depositionId,
        doi: publishData?.doi || depData?.doi || depData?.metadata?.doi || '',
        links: publishData?.links || depData?.links || {}
      });
    } catch (error) {
      console.error('Error uploading to Zenodo:', error);
      res.status(500).send(`Error uploading to Zenodo: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  app.put('/api/update-zenodo-paper', express.json(), async (req, res) => {
    try {
      const { depositionId, metadata, zenodoApiKey } = req.body;
      const rawKey = zenodoApiKey || (req.header('X-Zenodo-Api-Key') as string) || process.env.ZENODO_API_KEY || '';
      const ZENODO_API_KEY = rawKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();

      if (!depositionId || !ZENODO_API_KEY) {
        return res.status(400).send('Deposition ID and Zenodo API Key are required.');
      }

      const cleanMetadata = buildZenodoPayload(metadata);
      const url = `https://zenodo.org/api/deposit/depositions/${depositionId}`;

      const zRes = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ZENODO_API_KEY}`
        },
        body: JSON.stringify({ metadata: cleanMetadata })
      });

      if (!zRes.ok) {
        const errText = await zRes.text();
        console.error('DEBUG: Zenodo deposition update failed:', errText);
        let detailMessage = errText;
        try {
          const parsedErr = JSON.parse(errText);
          if (parsedErr.errors && Array.isArray(parsedErr.errors) && parsedErr.errors.length > 0) {
            detailMessage = parsedErr.errors.map((e: any) => `${e.field || 'field'}: ${e.message}`).join('; ');
          } else if (parsedErr.message) {
            detailMessage = parsedErr.message;
          }
        } catch (e) {}
        return res.status(zRes.status).send(`Zenodo update failed: ${detailMessage}`);
      }

      const updatedDep = await zRes.json();
      res.json({ message: 'Zenodo paper updated successfully', data: updatedDep });
    } catch (err: any) {
      console.error('Error in /api/update-zenodo-paper:', err);
      res.status(500).send(err.message || 'Failed to update Zenodo deposition');
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
