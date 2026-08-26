import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import multer from 'multer';
import pdfParse from 'pdf-parse';

import { GoogleGenAI } from '@google/genai';
import { google } from 'googleapis';

const rootDir = process.cwd();

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

function safeExtractJson<T = any>(raw: string | undefined | null, fallback: T): T {
  if (!raw || typeof raw !== 'string') return fallback;
  
  let cleaned = raw.trim();
  
  // Strip leading and trailing markdown code block formatting
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // 1. Direct parse attempt
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Continue with balanced extraction
  }

  // 2. Find opening bracket/brace
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');

  let isArray = false;
  let startIdx = -1;

  if (firstBrace !== -1 && firstBracket !== -1) {
    if (firstBracket < firstBrace) {
      isArray = true;
      startIdx = firstBracket;
    } else {
      isArray = false;
      startIdx = firstBrace;
    }
  } else if (firstBracket !== -1) {
    isArray = true;
    startIdx = firstBracket;
  } else if (firstBrace !== -1) {
    isArray = false;
    startIdx = firstBrace;
  }

  if (startIdx === -1) return fallback;

  const openChar = isArray ? '[' : '{';
  const closeChar = isArray ? ']' : '}';

  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;

  for (let i = startIdx; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '\\') {
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === openChar) {
        depth++;
      } else if (char === closeChar) {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
  }

  if (endIdx !== -1) {
    const snippet = cleaned.substring(startIdx, endIdx + 1);
    try {
      return JSON.parse(snippet);
    } catch (e) {
      try {
        const sanitized = snippet
          .replace(/,\s*([\}\]])/g, '$1')
          .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F]/g, '');
        return JSON.parse(sanitized);
      } catch (err) {
        // Fall through
      }
    }
  }

  const lastCloseIdx = cleaned.lastIndexOf(closeChar);
  if (lastCloseIdx > startIdx) {
    const snippet = cleaned.substring(startIdx, lastCloseIdx + 1);
    try {
      return JSON.parse(snippet);
    } catch (e) {
      try {
        const sanitized = snippet
          .replace(/,\s*([\}\]])/g, '$1')
          .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F]/g, '');
        return JSON.parse(sanitized);
      } catch (e2) {
        // Fall through
      }
    }
  }

  return fallback;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 }
  });

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

function safeString(val: any): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val).trim();
  if (Array.isArray(val)) {
    return val
      .map(item => safeString(item))
      .filter(Boolean)
      .join(', ');
  }
  if (typeof val === 'object') {
    if (val.url) return safeString(val.url);
    if (val.identifier) return safeString(val.identifier);
    if (val.link) return safeString(val.link);
    if (val.text) return safeString(val.text);
    if (val.name) return safeString(val.name);
    if (val.title) return safeString(val.title);
    try {
      return JSON.stringify(val);
    } catch {
      return '';
    }
  }
  return '';
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
  const tldr = safeString(metadata.tldr);
  if (tldr) {
    html += `<p><strong>⚡ TL;DR:</strong> ${escapeHtml(tldr)}</p>\n\n`;
  }

  // Abstract
  const abstract = safeString(metadata.abstract);
  if (abstract) {
    html += `<p><strong>Abstract:</strong> ${escapeHtml(abstract)}</p>\n\n`;
  }

  // Key Takeaways & Executive Highlights
  if (Array.isArray(metadata.keyTakeaways) && metadata.keyTakeaways.length > 0) {
    html += `<h3>Key Takeaways & Executive Highlights</h3>\n<ul>\n`;
    metadata.keyTakeaways.forEach((takeaway: any) => {
      const str = safeString(takeaway);
      if (str) {
        html += `  <li>${escapeHtml(str)}</li>\n`;
      }
    });
    html += `</ul>\n\n`;
  }

  // Novelties & Scientific Breakthroughs
  if (Array.isArray(metadata.novelties) && metadata.novelties.length > 0) {
    html += `<h3>Novelties & Core Innovations</h3>\n<ul>\n`;
    metadata.novelties.forEach((nov: any) => {
      const str = safeString(nov);
      if (str) {
        html += `  <li>${escapeHtml(str)}</li>\n`;
      }
    });
    html += `</ul>\n\n`;
  } else {
    const novStr = safeString(metadata.novelties);
    if (novStr) {
      html += `<h3>Novelties & Core Innovations</h3>\n<p>${escapeHtml(novStr)}</p>\n\n`;
    }
  }

  // Detailed Summary
  const summary = safeString(metadata.summary);
  if (summary) {
    html += `<h3>Summary & Key Contributions</h3>\n<p>${escapeHtml(summary)}</p>\n\n`;
  }

  // Methodology & Experimental Framework
  const methodology = safeString(metadata.methodology);
  if (methodology) {
    html += `<h3>Methodology & Experimental Framework</h3>\n<p>${escapeHtml(methodology)}</p>\n\n`;
  }

  // Datasets & Experimental Benchmarks
  if (Array.isArray(metadata.datasetsAndBenchmarks) && metadata.datasetsAndBenchmarks.length > 0) {
    html += `<h3>Datasets & Experimental Benchmarks</h3>\n<ul>\n`;
    metadata.datasetsAndBenchmarks.forEach((item: any) => {
      if (typeof item === 'string' && item.trim()) {
        html += `  <li>${escapeHtml(item.trim())}</li>\n`;
      } else if (item && typeof item === 'object') {
        const dsName = safeString(item.dataset || item.name || item.title);
        const dsRes = safeString(item.result || item.accuracy || item.score || item.value);
        if (dsName || dsRes) {
          html += `  <li><strong>${escapeHtml(dsName)}:</strong> ${escapeHtml(dsRes)}</li>\n`;
        }
      }
    });
    html += `</ul>\n\n`;
  } else {
    const dsStr = safeString(metadata.datasetsAndBenchmarks);
    if (dsStr) {
      html += `<h3>Datasets & Experimental Benchmarks</h3>\n<p>${escapeHtml(dsStr)}</p>\n\n`;
    }
  }

  // Practical Applications
  if (Array.isArray(metadata.practicalApplications) && metadata.practicalApplications.length > 0) {
    html += `<h3>Practical Applications & Industry Use Cases</h3>\n<ul>\n`;
    metadata.practicalApplications.forEach((app: any) => {
      const str = safeString(app);
      if (str) {
        html += `  <li>${escapeHtml(str)}</li>\n`;
      }
    });
    html += `</ul>\n\n`;
  }

  // Limitations & Future Work
  if (Array.isArray(metadata.limitationsAndFutureWork) && metadata.limitationsAndFutureWork.length > 0) {
    html += `<h3>Limitations & Future Research Directions</h3>\n<ul>\n`;
    metadata.limitationsAndFutureWork.forEach((lim: any) => {
      const str = safeString(lim);
      if (str) {
        html += `  <li>${escapeHtml(str)}</li>\n`;
      }
    });
    html += `</ul>\n\n`;
  } else {
    const limStr = safeString(metadata.limitationsAndFutureWork);
    if (limStr) {
      html += `<h3>Limitations & Future Research Directions</h3>\n<p>${escapeHtml(limStr)}</p>\n\n`;
    }
  }

  // Target Audience & Required Background
  const targetAudience = safeString(metadata.targetAudience);
  if (targetAudience) {
    html += `<p><strong>Target Audience & Domain Area:</strong> ${escapeHtml(targetAudience)}</p>\n\n`;
  }

  // Code, Data & Artifact Repositories
  const codeAndDataLinks = safeString(metadata.codeAndDataLinks);
  if (codeAndDataLinks) {
    html += `<p><strong>Code, Data & Reproducibility Links:</strong> ${escapeHtml(codeAndDataLinks)}</p>\n\n`;
  }

  // Detailed Glossary
  if (Array.isArray(metadata.glossary) && metadata.glossary.length > 0) {
    html += `<h3>Detailed Glossary & Technical Terms</h3>\n<dl>\n`;
    metadata.glossary.forEach((item: any) => {
      if (item) {
        const term = safeString(item.term);
        const def = safeString(item.definition);
        if (term && def) {
          html += `  <dt><strong>${escapeHtml(term)}</strong></dt>\n`;
          html += `  <dd>${escapeHtml(def)}</dd>\n`;
        }
      }
    });
    html += `</dl>\n\n`;
  }

  // Up to 20 FAQs
  if (Array.isArray(metadata.faq) && metadata.faq.length > 0) {
    html += `<h3>Frequently Asked Questions (FAQ)</h3>\n`;
    metadata.faq.slice(0, 20).forEach((item: any, idx: number) => {
      if (item) {
        const q = safeString(item.question);
        const a = safeString(item.answer);
        if (q && a) {
          html += `<p><strong>Q${idx + 1}: ${escapeHtml(q)}</strong><br/>\n`;
          html += `A: ${escapeHtml(a)}</p>\n\n`;
        }
      }
    });
  }

  // Author WHOIS Bios
  if (Array.isArray(metadata.authors) && metadata.authors.some((a: any) => a?.whoisBio)) {
    html += `<h3>Author WHOIS Biographies</h3>\n<ul>\n`;
    metadata.authors.forEach((a: any) => {
      if (a && a.name) {
        const name = safeString(a.name);
        const aff = safeString(a.affiliation);
        const bio = safeString(a.whoisBio);
        if (name) {
          html += `  <li><strong>${escapeHtml(name)}</strong>`;
          if (aff) html += ` (<em>${escapeHtml(aff)}</em>)`;
          if (bio) html += `: ${escapeHtml(bio)}`;
          html += `</li>\n`;
        }
      }
    });
    html += `</ul>\n\n`;
  }

  // Long-Tail & Standard Keywords Index
  const allKeywords = [
    ...(Array.isArray(metadata.seoKeywords) ? metadata.seoKeywords : []),
    ...(Array.isArray(metadata.longTailKeywords) ? metadata.longTailKeywords : [])
  ].map(k => safeString(k)).filter(Boolean);

  if (allKeywords.length > 0) {
    html += `<p><strong>Search Index & Long-Tail Keywords:</strong> ${allKeywords.map(k => escapeHtml(k)).join(', ')}</p>\n`;
  }

  const fundingInfo = safeString(metadata.fundingInformation);
  if (fundingInfo) {
    html += `<p><strong>Funding & Acknowledgments:</strong> ${escapeHtml(fundingInfo)}</p>\n`;
  }

  return html.trim() || `<p>${escapeHtml(safeString(metadata.title) || 'Research paper upload')}</p>`;
}

function formatZenodoDate(dateStr?: any): string {
  const today = new Date().toISOString().split('T')[0];
  if (!dateStr) return today;
  const trimmed = safeString(dateStr).trim();
  if (!trimmed) return today;
  
  // 1. Strict YYYY-MM-DD with valid range checks
  const ymdMatch = trimmed.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (ymdMatch) {
    const y = parseInt(ymdMatch[1], 10);
    const m = parseInt(ymdMatch[2], 10);
    const d = parseInt(ymdMatch[3], 10);
    if (y >= 1000 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // 2. Strict YYYY-MM
  const ymMatch = trimmed.match(/^(\d{4})[/-](\d{1,2})$/);
  if (ymMatch) {
    const y = parseInt(ymMatch[1], 10);
    const m = parseInt(ymMatch[2], 10);
    if (y >= 1000 && y <= 9999 && m >= 1 && m <= 12) {
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
    }
  }

  // 3. Strict YYYY
  const yMatch = trimmed.match(/^(\d{4})$/);
  if (yMatch) {
    const y = parseInt(yMatch[1], 10);
    if (y >= 1000 && y <= 9999) {
      return `${String(y).padStart(4, '0')}`;
    }
  }

  // 4. ISO Date timestamp (e.g. 2024-03-12T14:30:00Z)
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10);
    const d = parseInt(isoMatch[3], 10);
    if (y >= 1000 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // 5. General Date.parse
  try {
    const parsed = Date.parse(trimmed);
    if (!isNaN(parsed)) {
      const d = new Date(parsed);
      if (!isNaN(d.getTime())) {
        const yyyy = d.getFullYear();
        if (yyyy >= 1000 && yyyy <= 9999) {
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          return `${yyyy}-${mm}-${dd}`;
        }
      }
    }
  } catch (e) {}

  // 6. Year fallback in text
  const yearMatch = trimmed.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    return `${yearMatch[0]}-01-01`;
  }
  return today;
}

function sanitizeRelatedIdentifiers(rawIdentifiers: any[], codeAndDataLinks?: any): any[] {
  const validSchemes = new Set(['doi', 'isbn', 'issn', 'url', 'urn', 'handle', 'arxiv', 'pmid', 'orcid', 'gnd', 'ads', 'citeproc', 'purl', 'swh']);
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
  if (codeAndDataLinks) {
    if (typeof codeAndDataLinks === 'string' && codeAndDataLinks.trim()) {
      list.push({ identifier: codeAndDataLinks.trim(), scheme: 'url', relation: 'isSupplementTo' });
    } else if (Array.isArray(codeAndDataLinks)) {
      codeAndDataLinks.forEach(link => {
        const linkStr = safeString(link);
        if (linkStr) {
          list.push({ identifier: linkStr, scheme: 'url', relation: 'isSupplementTo' });
        }
      });
    } else if (typeof codeAndDataLinks === 'object') {
      const linkStr = safeString(codeAndDataLinks);
      if (linkStr) {
        list.push({ identifier: linkStr, scheme: 'url', relation: 'isSupplementTo' });
      }
    }
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

    // Process DOI
    if (idStr.startsWith('10.') || /^doi:/i.test(idStr) || /^https?:\/\/(dx\.)?doi\.org\//i.test(idStr) || scheme === 'doi') {
      const strippedDoi = idStr.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
      if (/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/.test(strippedDoi)) {
        scheme = 'doi';
        idStr = strippedDoi;
      } else if (idStr.startsWith('http://') || idStr.startsWith('https://')) {
        scheme = 'url';
      } else {
        continue;
      }
    }

    // Process arXiv
    if (scheme === 'arxiv' || /^arxiv:/i.test(idStr) || /^https?:\/\/arxiv\.org\//i.test(idStr)) {
      if (idStr.startsWith('http://') || idStr.startsWith('https://')) {
        scheme = 'url';
      } else {
        const strippedArxiv = idStr.replace(/^arxiv:\s*/i, '').trim();
        if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(strippedArxiv)) {
          scheme = 'arxiv';
          idStr = strippedArxiv;
        } else {
          scheme = 'url';
          idStr = `https://arxiv.org/abs/${strippedArxiv}`;
        }
      }
    }

    // Process URLs
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

    // Pattern validations per scheme
    if (scheme === 'doi' && !/^10\.\d{4,9}\/[^\s]+$/.test(idStr)) {
      continue;
    }
    if (scheme === 'url' && !/^https?:\/\/[^\s]+$/.test(idStr)) {
      continue;
    }
    if (scheme === 'issn' && !/^\d{4}-\d{3}[\dX]$/.test(idStr)) {
      continue;
    }
    if (scheme === 'orcid' && !/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(idStr)) {
      continue;
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
    creatorsList = [{ name: 'Research Author' }];
  }

  const zenodoCreators = creatorsList.map((a: any) => {
    let nameStr = typeof a === 'string' ? a : (a?.name || '');
    nameStr = nameStr.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!nameStr || nameStr.toLowerCase() === 'n/a' || nameStr.toLowerCase() === 'null') {
      nameStr = 'Research Author';
    }
    const creatorObj: any = { name: nameStr };
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
      if (a.gnd && typeof a.gnd === 'string' && a.gnd.trim()) {
        let cleanGnd = a.gnd.trim();
        if (/^\d{1,10}[-\dX]?$/.test(cleanGnd)) {
          creatorObj.gnd = cleanGnd;
        }
      }
    }
    return creatorObj;
  }).filter((c: any) => Boolean(c.name));

  if (zenodoCreators.length === 0) {
    zenodoCreators.push({ name: 'Research Author' });
  }

  const validUploadTypes = new Set(["publication", "poster", "presentation", "dataset", "image", "video", "software", "lesson", "other"]);
  const validPublicationTypes = new Set(["book", "section", "article", "conferencepaper", "report", "patent", "thesis", "technicalnote", "workingpaper", "preprint", "other"]);

  let uploadType = (metadata.uploadType || metadata.upload_type || "publication").toLowerCase().trim();
  if (uploadType === "paper" || uploadType === "journal" || uploadType === "manuscript") uploadType = "publication";
  if (!validUploadTypes.has(uploadType)) {
    uploadType = "publication";
  }

  const zenodoMetadata: any = {
    title: (metadata.title || 'Untitled Research Paper').trim() || 'Untitled Research Paper',
    upload_type: uploadType,
    description: richDescriptionHTML,
    publication_date: formatZenodoDate(metadata.publicationDate || metadata.publication_date),
    creators: zenodoCreators,
    access_right: "open"
  };

  if (uploadType === "publication") {
    let pubType = (metadata.publicationType || metadata.publication_type || "article").toLowerCase().trim();
    if (pubType.includes('journal') || pubType === 'paper') pubType = 'article';
    else if (pubType.includes('conf') || pubType.includes('proceeding')) pubType = 'conferencepaper';
    else if (pubType.includes('prep') || pubType.includes('arxiv')) pubType = 'preprint';
    if (!validPublicationTypes.has(pubType)) {
      pubType = "article";
    }
    zenodoMetadata.publication_type = pubType;
  }

  // Pre-reserved Zenodo DOIs (10.5281/zenodo.X or 10.5072/zenodo.X) can go into doi field; external DOIs must go to related_identifiers
  if (metadata.doi && typeof metadata.doi === 'string') {
    let cleanDoi = metadata.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
    if (/^10\.5281\/zenodo\.\d+$/i.test(cleanDoi) || /^10\.5072\/zenodo\.\d+$/i.test(cleanDoi)) {
      zenodoMetadata.doi = cleanDoi;
    } else if (/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/.test(cleanDoi)) {
      if (!zenodoMetadata.related_identifiers) {
        zenodoMetadata.related_identifiers = [];
      }
      if (!zenodoMetadata.related_identifiers.some((r: any) => r.identifier === cleanDoi && r.scheme === 'doi')) {
        zenodoMetadata.related_identifiers.push({
          identifier: cleanDoi,
          relation: 'isAlternateIdentifier',
          scheme: 'doi'
        });
      }
    }
  }

  if (metadata.language && typeof metadata.language === 'string') {
    let lang = metadata.language.trim().toLowerCase();
    if (lang === 'en' || lang === 'english') lang = 'eng';
    else if (lang === 'fr' || lang === 'french') lang = 'fra';
    else if (lang === 'de' || lang === 'german') lang = 'deu';
    else if (lang === 'es' || lang === 'spanish') lang = 'spa';
    else if (lang === 'it' || lang === 'italian') lang = 'ita';
    else if (lang === 'pt' || lang === 'portuguese') lang = 'por';
    else if (lang === 'ru' || lang === 'russian') lang = 'rus';
    else if (lang === 'zh' || lang === 'chinese') lang = 'zho';
    else if (lang === 'ja' || lang === 'japanese') lang = 'jpn';
    if (/^[a-z]{3}$/.test(lang)) {
      zenodoMetadata.language = lang;
    }
  }

  const VALID_ZENODO_LICENSES = new Set([
    'cc-by-4.0', 'cc-by-sa-4.0', 'cc-by-nc-4.0', 'cc-by-nd-4.0', 'cc-by-nc-sa-4.0', 'cc-by-nc-nd-4.0',
    'cc0-1.0', 'mit', 'apache-2.0', 'gpl-3.0', 'gpl-2.0', 'lgpl-3.0', 'bsd-3-clause', 'bsd-2-clause',
    'isc', 'other-open', 'other-closed', 'other-pd'
  ]);

  if (metadata.license && typeof metadata.license === 'string') {
    let lic = metadata.license.trim().toLowerCase();
    if (lic.includes('cc-by-4') || lic.includes('cc by 4') || lic.includes('attribution 4')) lic = 'cc-by-4.0';
    else if (lic.includes('cc-by-sa') || lic.includes('sharealike')) lic = 'cc-by-sa-4.0';
    else if (lic.includes('cc-by-nc-sa')) lic = 'cc-by-nc-sa-4.0';
    else if (lic.includes('cc-by-nc')) lic = 'cc-by-nc-4.0';
    else if (lic.includes('cc-by-nd')) lic = 'cc-by-nd-4.0';
    else if (lic.includes('cc0') || lic.includes('public domain')) lic = 'cc0-1.0';
    else if (lic.includes('mit')) lic = 'mit';
    else if (lic.includes('gpl-3') || lic === 'gpl') lic = 'gpl-3.0';
    else if (lic.includes('gpl-2')) lic = 'gpl-2.0';
    else if (lic.includes('apache')) lic = 'apache-2.0';
    else if (lic.includes('bsd-3')) lic = 'bsd-3-clause';
    else if (lic.includes('bsd-2')) lic = 'bsd-2-clause';

    if (VALID_ZENODO_LICENSES.has(lic)) {
      zenodoMetadata.license = lic;
    } else {
      zenodoMetadata.license = 'cc-by-4.0';
    }
  } else {
    zenodoMetadata.license = 'cc-by-4.0';
  }

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
    zenodoMetadata.keywords = Array.from(keywordSet).slice(0, 30);
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
      zenodoMetadata.references = refs.slice(0, 50);
    }
  }

  if (metadata.journalName && typeof metadata.journalName === 'string' && metadata.journalName.trim()) {
    zenodoMetadata.journal_title = metadata.journalName.trim();
  }

  if (metadata.journalIssn && typeof metadata.journalIssn === 'string') {
    let cleanIssn = metadata.journalIssn.replace(/[^0-9X]/gi, '').toUpperCase();
    if (cleanIssn.length === 8) {
      cleanIssn = `${cleanIssn.slice(0, 4)}-${cleanIssn.slice(4, 8)}`;
    }
    if (/^\d{4}-\d{3}[\dX]$/.test(cleanIssn)) {
      zenodoMetadata.journal_issn = cleanIssn;
    }
  }

  const cleanedRelatedIds = sanitizeRelatedIdentifiers(metadata.identifiers, metadata.codeAndDataLinks);
  if (cleanedRelatedIds.length > 0) {
    const existing = zenodoMetadata.related_identifiers || [];
    zenodoMetadata.related_identifiers = [...existing, ...cleanedRelatedIds];
  }

  return zenodoMetadata;
}

const GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.7-flash',
  'gemini-2.5-flash',
  'gemini-3.1-pro-preview',
  'gemini-flash-latest'
];

function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });
}

async function generateContentWithFallback(ai: GoogleGenAI, request: { contents: any, config?: any }): Promise<any> {
  let lastErr: any = null;
  const maxPoolPasses = 2;

  for (let pass = 0; pass < maxPoolPasses; pass++) {
    if (pass > 0) {
      // Exponential backoff before second pass across all models
      await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 500));
    }

    for (const modelName of GEMINI_MODELS) {
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout waiting for Gemini model ${modelName}`)), 25000)
        );
        const result = await Promise.race([
          ai.models.generateContent({
            model: modelName,
            contents: request.contents,
            config: request.config
          }),
          timeoutPromise
        ]) as any;
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

        const isTemporaryCapacity = status === 503 || status === 429 || (msg && (
          msg.includes('503') ||
          msg.includes('429') ||
          msg.includes('RESOURCE_EXHAUSTED') ||
          msg.includes('high load') ||
          msg.includes('overloaded') ||
          msg.includes('capacity')
        ));

        // When high load 503 is returned, failover gracefully to the next independent model in pool
        if (isTemporaryCapacity) {
          await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 300));
        }
      }
    }
  }

  throw lastErr || new Error('All Gemini model attempts failed.');
}

function parseMetadataFromPdfText(text: string, filename: string = ''): any {
  const cleanText = safeString(text).replace(/\r\n/g, '\n').trim();
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
      return res.status(400).json({ error: 'No file uploaded.' });
    }
    try {
      if (!file || !file.buffer || file.buffer.length === 0) {
        return res.status(400).json({ error: 'Uploaded file is empty (0 bytes). Please ensure your PDF is downloaded and try again.' });
      }
      
      const headerSnippet = file.buffer.slice(0, 8192).toString('binary');
      const isPdfHeader = headerSnippet.includes('%PDF-');
      const isPdfExtension = (file.originalname || '').toLowerCase().endsWith('.pdf');
      const isPdfMime = (file.mimetype || '').includes('pdf') || (file.mimetype || '').includes('octet-stream');

      if (!isPdfHeader && !isPdfExtension && !isPdfMime) {
        return res.status(400).json({ error: 'Not a recognized PDF document format. Please upload a standard .pdf file.' });
      }
      
      console.log('DEBUG: Preparing PDF for processing...');
      console.log('DEBUG: File name:', file.originalname, 'Size:', file.buffer.length, 'bytes');

      let extractedText = '';
      try {
        const parsePdfFunc = typeof pdfParse === 'function' ? pdfParse : (pdfParse as any)?.default;
        if (typeof parsePdfFunc === 'function') {
          const parsedPdf = await parsePdfFunc(file.buffer);
          if (parsedPdf && parsedPdf.text && parsedPdf.text.trim().length > 30) {
            extractedText = parsedPdf.text.trim().substring(0, 40000);
            console.log('DEBUG: Extracted text from PDF using pdf-parse, length:', extractedText.length);
          }
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
          const ai = createGeminiClient(apiKey);
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
            let paperContext = extractedText;
            if (extractedText.length > 45000) {
              const head = extractedText.substring(0, 35000);
              const tail = extractedText.substring(extractedText.length - 10000);
              paperContext = `${head}\n\n[... middle sections omitted for speed ...]\n\n${tail}`;
            }
            parts.push({ text: `Research Paper Text:\n\n${paperContext}` });
          } else if (file.buffer && file.buffer.length < 10 * 1024 * 1024) {
            parts.push({ inlineData: { data: file.buffer.toString('base64'), mimeType: 'application/pdf' } });
          } else {
            parts.push({ text: `Filename: ${file.originalname || 'paper.pdf'}` });
          }

          console.log('DEBUG: Attempting Gemini AI extraction...');
          const result = await generateContentWithFallback(ai, {
            contents: [{ role: 'user', parts }],
            config: { responseMimeType: "application/json" }
          });

          metadata = safeExtractJson(result.text, null);
        } catch (aiErr: any) {
          console.warn('DEBUG: Gemini AI metadata extraction failed:', aiErr?.message || aiErr);
        }
      }

      if (!metadata) {
        console.log('DEBUG: Fallback to PDF text parser metadata extraction...');
        metadata = parseMetadataFromPdfText(extractedText, file.originalname || 'paper.pdf');
      } else {
        // Format authors cleanly without blocking on multiple live search queries
        if (Array.isArray(metadata.authors) && metadata.authors.length > 0) {
          metadata.authors = metadata.authors.map((author: any) => {
            if (typeof author === 'string') {
              return { name: author.trim(), affiliation: '', url: '' };
            }
            return {
              name: (author?.name || 'Unknown Author').trim(),
              affiliation: (author?.affiliation || '').trim(),
              url: (author?.url || '').trim(),
              whoisBio: author?.whoisBio || '',
              whoisSources: Array.isArray(author?.whoisSources) ? author.whoisSources : []
            };
          });
        }
      }

      return res.json(metadata);
    } catch (error: any) {
      console.error('Error in processing PDF:', error);
      let msg = error.message || (typeof error === 'string' ? error : 'An unexpected error occurred while processing the PDF.');
      if (msg.includes('API_KEY_INVALID') || msg.includes('API key not valid')) {
        msg = 'Invalid or unauthorized Gemini API key. Please check your Gemini API key in Settings or the API key input.';
        return res.status(401).json({ error: msg });
      }
      
      // Fallback gracefully so user can continue
      try {
        const fallback = parseMetadataFromPdfText('', file?.originalname || 'Uploaded Research Paper.pdf');
        return res.json(fallback);
      } catch {
        res.status(500).json({ error: msg });
      }
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

      const ai = createGeminiClient(apiKey);
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

      const ai = createGeminiClient(apiKey);
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

      const glossary = safeExtractJson(response.text, []);
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
      const ai = createGeminiClient(apiKey);
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

      const faq = safeExtractJson(response.text, []);
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

      const ai = createGeminiClient(apiKey);
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

      const data = safeExtractJson(response.text, { tldr: '' });
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

      const ai = createGeminiClient(apiKey);
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

      const takeaways = safeExtractJson(response.text, []);
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

      const ai = createGeminiClient(apiKey);
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

      const benchmarks = safeExtractJson(response.text, []);
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

      const ai = createGeminiClient(apiKey);
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

      const limitations = safeExtractJson(response.text, []);
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

      const ai = createGeminiClient(apiKey);
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

      const novelties = safeExtractJson(response.text, []);
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

      const ai = createGeminiClient(apiKey);
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

      const keywords = safeExtractJson(response.text, []);
      res.json({ keywords });
    } catch (err: any) {
      console.error('Error in /api/generate-keywords:', err);
      res.status(500).send(err.message || 'Failed to generate keywords');
    }
  });


  app.post('/api/upload-to-zenodo', upload.single('pdf'), async (req, res) => {
    console.log('DEBUG: /api/upload-to-zenodo called');
    const file = (req as any).file;
    let metadata: any = null;
    if (req.body && req.body.metadata) {
      if (typeof req.body.metadata === 'string') {
        try {
          metadata = JSON.parse(req.body.metadata);
        } catch (e) {
          console.error('Failed to parse metadata JSON string:', e);
        }
      } else if (typeof req.body.metadata === 'object') {
        metadata = req.body.metadata;
      }
    }
    
    if (!file) {
      return res.status(400).send('No PDF file provided for upload.');
    }

    if (!metadata) {
      console.log('DEBUG: Metadata not provided in upload request, extracting fallback metadata from file...');
      let extractedText = '';
      try {
        const parsePdfFunc = typeof pdfParse === 'function' ? pdfParse : (pdfParse as any)?.default;
        if (typeof parsePdfFunc === 'function') {
          const parsedPdf = await parsePdfFunc(file.buffer);
          if (parsedPdf?.text) extractedText = parsedPdf.text.trim().substring(0, 40000);
        }
      } catch (e) {}
      if (!extractedText) {
        extractedText = fallbackExtractPdfText(file.buffer);
      }
      metadata = parseMetadataFromPdfText(extractedText, file.originalname || 'paper.pdf');
    }

    try {
      const rawZenodoKey = (req.body && req.body.zenodoApiKey) || (req.header('X-Zenodo-Api-Key') as string) || process.env.ZENODO_API_KEY || '';
      const ZENODO_API_KEY = rawZenodoKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();
      if (!ZENODO_API_KEY) {
        return res.status(401).send('Zenodo API Key is missing. Please enter your Zenodo Personal Access Token in API Settings.');
      }

      const originalName = file.originalname || 'paper.pdf';
      const safeFilename = originalName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/_+/g, '_')
        .trim() || 'paper.pdf';
      
      const zenodoMetadata = buildZenodoPayload(metadata);
      
      // Support both production Zenodo and Zenodo Sandbox with seamless failover
      const baseUrls = [
        'https://zenodo.org/api/deposit/depositions',
        'https://sandbox.zenodo.org/api/deposit/depositions'
      ];

      let depResponse: any = null;
      let activeBaseUrl = baseUrls[0];
      let lastErrText = '';

      for (const currentBaseUrl of baseUrls) {
        try {
          console.log(`DEBUG: Attempting Zenodo deposition on ${currentBaseUrl}...`);
          depResponse = await fetch(currentBaseUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${ZENODO_API_KEY}`
            },
            body: JSON.stringify({ metadata: zenodoMetadata })
          });

          if (depResponse.ok) {
            activeBaseUrl = currentBaseUrl;
            break;
          }

          lastErrText = await depResponse.text();
          console.warn(`DEBUG: Zenodo attempt on ${currentBaseUrl} returned ${depResponse.status}:`, lastErrText);

          // If validation or schema error (e.g. pattern mismatch on auxiliary field), try minimal safe schema
          if (depResponse.status === 400) {
            console.log(`DEBUG: Attempting deposition with minimal clean schema on ${currentBaseUrl}...`);
            const firstAuthor = Array.isArray(metadata.authors) && metadata.authors[0] && metadata.authors[0].name
              ? String(metadata.authors[0].name).trim()
              : 'Research Author';
            const safeCleanPayload = {
              title: (metadata.title || 'Untitled Research Paper').trim() || 'Untitled Research Paper',
              upload_type: 'publication',
              publication_type: 'article',
              description: buildZenodoDescriptionHTML(metadata) || '<p>Research paper uploaded via ZenUploader.</p>',
              publication_date: formatZenodoDate(metadata.publicationDate),
              creators: [{ name: firstAuthor || 'Research Author' }],
              access_right: 'open',
              license: 'cc-by-4.0'
            };

            try {
              const fallbackDepRes = await fetch(currentBaseUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${ZENODO_API_KEY}`
                },
                body: JSON.stringify({ metadata: safeCleanPayload })
              });

              if (fallbackDepRes.ok) {
                depResponse = fallbackDepRes;
                activeBaseUrl = currentBaseUrl;
                break;
              } else {
                lastErrText = await fallbackDepRes.text();
                console.warn(`DEBUG: Fallback deposition attempt also failed on ${currentBaseUrl}:`, lastErrText);
              }
            } catch (fallbackNetErr: any) {
              console.warn(`DEBUG: Fallback network error on ${currentBaseUrl}:`, fallbackNetErr);
            }
          }

          // If unauthorized or invalid token on production, try sandbox
          if (depResponse.status === 401 || depResponse.status === 403) {
            continue;
          } else {
            break;
          }
        } catch (netErr: any) {
          lastErrText = netErr.message || String(netErr);
          console.warn(`DEBUG: Network error connecting to ${currentBaseUrl}:`, lastErrText);
        }
      }
      
      if (!depResponse || !depResponse.ok) {
        let detailMessage = lastErrText || 'Zenodo rejected the deposition request.';
        try {
          const parsedErr = JSON.parse(lastErrText);
          if (parsedErr.errors && Array.isArray(parsedErr.errors) && parsedErr.errors.length > 0) {
            detailMessage = parsedErr.errors.map((e: any) => `${e.field || 'field'}: ${e.message}`).join('; ');
          } else if (parsedErr.message) {
            detailMessage = parsedErr.message;
          }
        } catch (e) {}
        throw new Error(`Zenodo Deposition creation failed (${depResponse?.status || 400}): ${detailMessage}`);
      }
      
      const depData = await depResponse.json();
      const depositionId = depData.id;
      console.log('DEBUG: Deposition created successfully, ID:', depositionId, 'on', activeBaseUrl);
      
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
        const fileUrl = `${activeBaseUrl}/${depositionId}/files`;
        const formData = new FormData();
        const uploadFile = new Blob([file.buffer], { type: 'application/pdf' });
        formData.append('file', uploadFile, safeFilename);
        formData.append('name', safeFilename);
        
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
        const publishResponse = await fetch(`${activeBaseUrl}/${depositionId}/actions/publish`, {
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
        links: publishData?.links || depData?.links || {},
        environment: activeBaseUrl.includes('sandbox') ? 'sandbox' : 'production'
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

  app.get('/api/get-zenodo-papers', async (req, res) => {
    try {
      const rawKey = (req.query.zenodoApiKey as string) || (req.header('X-Zenodo-Api-Key') as string) || process.env.ZENODO_API_KEY || '';
      const ZENODO_API_KEY = rawKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();
      if (!ZENODO_API_KEY) {
        return res.json([]);
      }
      const response = await fetch('https://zenodo.org/api/deposit/depositions?size=100', {
        headers: {
          'Authorization': `Bearer ${ZENODO_API_KEY}`
        }
      });
      if (!response.ok) {
        const errTxt = await response.text();
        console.warn('Failed to fetch Zenodo depositions from server:', response.status, errTxt);
        return res.json([]);
      }
      const data = await response.json();
      res.json(data);
    } catch (err: any) {
      console.error('Error fetching Zenodo papers:', err);
      res.status(500).send(err.message || 'Failed to fetch Zenodo depositions');
    }
  });

  app.post('/api/delete-zenodo-paper', express.json(), async (req, res) => {
    try {
      const { depositionId, zenodoApiKey } = req.body;
      const rawKey = zenodoApiKey || (req.header('X-Zenodo-Api-Key') as string) || process.env.ZENODO_API_KEY || '';
      const ZENODO_API_KEY = rawKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();
      if (!depositionId || !ZENODO_API_KEY) {
        return res.status(400).send('Deposition ID and Zenodo API Key are required.');
      }
      const url = `https://zenodo.org/api/deposit/depositions/${depositionId}`;
      const zRes = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${ZENODO_API_KEY}`
        }
      });
      if (!zRes.ok && zRes.status !== 404) {
        const errTxt = await zRes.text();
        console.warn('Zenodo deletion failed:', zRes.status, errTxt);
        return res.status(zRes.status).send(`Zenodo delete failed: ${errTxt}`);
      }
      res.json({ message: 'Paper deleted from Zenodo successfully or already removed.' });
    } catch (err: any) {
      console.error('Error deleting Zenodo paper:', err);
      res.status(500).send(err.message || 'Failed to delete Zenodo deposition');
    }
  });

  app.post('/api/support-chat', express.json(), async (req, res) => {
    try {
      const { messages, audience, prompt, geminiApiKey } = req.body;
      const rawApiKey = geminiApiKey || (req.header('X-Gemini-Api-Key') as string) || (req.headers['x-gemini-api-key'] as string) || process.env.GEMINI_API_KEY || '';
      const apiKey = rawApiKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();

      const userPrompt = prompt || (Array.isArray(messages) && messages.length > 0 ? messages[messages.length - 1].content : '');

      const isUserGuideSummary = /what is this and how does it work\??/i.test(userPrompt) || /user guide/i.test(userPrompt) || /how does it work/i.test(userPrompt);

      const isCommunityGroupQuery = /community/i.test(userPrompt) || /google group/i.test(userPrompt) || /forum/i.test(userPrompt) || /support group/i.test(userPrompt);

      if (isCommunityGroupQuery) {
        return res.json({
          reply: `### 👥 ZenUploader Community Support Group

You can join and participate in our official Google Group community here:
👉 **[groups.google.com/g/zenuploader](https://groups.google.com/g/zenuploader)**

In the community group, you can:
- Ask questions and get answers from researchers and Zenodo users
- Request feature enhancements
- Report issues or share feedback
- Stay updated on new releases and features`
        });
      }

      if (isUserGuideSummary) {
        const guideSummary = `### 🌟 Welcome to ZenUploader — Automated AI Uploader for Zenodo

**ZenUploader** is an automated research assistant designed to publish manuscripts directly to **Zenodo** (CERN's open-access data repository).

---

### 🚀 How It Works (The 2-Step Workflow)

1. **Step 1: Process PDF Document & Extract AI Metadata**
   - Upload your manuscript PDF via drag-and-drop or file upload.
   - **Gemini AI** extracts titles, abstracts, publication dates, and funding grants.
   - Generates executive **TL;DRs**, **4-8 Novelty bullets**, **8-15 Glossary definitions**, and **up to 20 detailed FAQs**.
   - Runs live web searches to compile **Author WHOIS Biographies** with institutional affiliations and source links.

2. **Step 2: Review & Final Upload to Zenodo**
   - Review and customize any extracted metadata field on your interactive dashboard.
   - Enter your personal **Zenodo Access Token** (generated at \`zenodo.org/account/settings/applications/\` with \`deposit:write\` & \`deposit:actions\` scopes).
   - Click **Step 2: Final Upload to Zenodo** to publish the deposition directly to Zenodo servers.
   - Receive an instant **DOI link** and sync the submission to your submission history log.

---

### 👥 Community Support Group
Join our official user community at **[groups.google.com/g/zenuploader](https://groups.google.com/g/zenuploader)** to discuss features, report issues, and share feedback!

---

### 🛡️ For Zenodo Staff & Business Operations
- **DataCite Compliance**: Submissions map cleanly to DataCite/Dublin Core standard fields.
- **Deposition Updates**: Uses \`PUT /api/update-zenodo-paper\` to update existing draft metadata without re-uploading files.
- **Full Guide**: The complete User Guide is always available at the bottom of the website footer!`;

        return res.json({ reply: guideSummary });
      }

      if (apiKey) {
        try {
          const ai = createGeminiClient(apiKey);

          const systemInstruction = `You are the official ZenUploader AI Support Assistant, providing helpful client support for researchers/users and specialized operational support for Zenodo staff.

System Context:
- ZenUploader is an independent third-party tool and is NOT affiliated with or endorsed by Zenodo or CERN.
- AI Accuracy Notice: AI can make mistakes or generate inaccuracies. Always advise users to review and verify extracted metadata before final submission.
- 2-Step Workflow: Step 1 (Process PDF & AI Extract), Step 2 (Review & Final Upload to Zenodo).
- Features: Gemini AI metadata extraction, WHOIS Author Biographies, Glossaries, 20 FAQs, Executive TL;DRs, DataCite compliance, Zenodo API integration.
- Zenodo API key setup: Users need a Personal Access Token from https://zenodo.org/account/settings/applications/ with 'deposit:write' and 'deposit:actions' scopes.
- Community Group: https://groups.google.com/g/zenuploader
- Zenodo Staff support: API endpoints (/api/process-pdf, /api/upload-to-zenodo, /api/update-zenodo-paper), rate limits, DataCite schema mapping.

Respond clearly, professionally, and concisely in markdown format. Use bullet points and bold text for readability.`;

          let contextPrompt = `${systemInstruction}\n\nAudience Mode: ${audience === 'staff' ? 'Zenodo Staff & Business Operations' : 'Researcher / Client Support'}\n\nUser Question: ${userPrompt}`;

          const result = await generateContentWithFallback(ai, {
            contents: contextPrompt
          });

          const replyText = result.text || "I'm here to help with ZenUploader, PDF metadata extraction, and Zenodo publishing.";
          return res.json({ reply: replyText });
        } catch (aiErr: any) {
          console.warn('Support Chat AI fallback:', aiErr?.message || aiErr);
        }
      }

      // Default fallback if no API key or AI call failed
      const fallbackReply = `**ZenUploader Support**:
ZenUploader automates publishing research PDFs to Zenodo in 2 simple steps:
1. **Step 1: Process PDF Document** — AI extracts title, abstract, authors, WHOIS bios, glossaries, and FAQs.
2. **Step 2: Final Upload to Zenodo** — Review metadata and submit to Zenodo with your Personal Access Token.

You can view the full User Guide in the website footer or add your Gemini API key in Settings for custom AI support.`;

      return res.json({ reply: fallbackReply });
    } catch (err: any) {
      console.error('Error in /api/support-chat:', err);
      res.status(500).send('Error in support chat assistant');
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
    const distPath = path.join(rootDir, 'dist');
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
