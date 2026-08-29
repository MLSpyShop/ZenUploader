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
      console.log(`Search-grounded WHOIS fallback for ${cleanName}, trying standard generation...`);
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
  
  // 1. Strict YYYY-MM-DD
  const ymdMatch = trimmed.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (ymdMatch) {
    const y = parseInt(ymdMatch[1], 10);
    const m = Math.min(Math.max(parseInt(ymdMatch[2], 10), 1), 12);
    const d = Math.min(Math.max(parseInt(ymdMatch[3], 10), 1), 31);
    if (y >= 1000 && y <= 9999) {
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // 2. Strict YYYY-MM -> Convert to YYYY-MM-01
  const ymMatch = trimmed.match(/^(\d{4})[/-](\d{1,2})$/);
  if (ymMatch) {
    const y = parseInt(ymMatch[1], 10);
    const m = Math.min(Math.max(parseInt(ymMatch[2], 10), 1), 12);
    if (y >= 1000 && y <= 9999) {
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
    }
  }

  // 3. Strict YYYY -> Convert to YYYY-01-01
  const yMatch = trimmed.match(/^(\d{4})$/);
  if (yMatch) {
    const y = parseInt(yMatch[1], 10);
    if (y >= 1000 && y <= 9999) {
      return `${String(y).padStart(4, '0')}-01-01`;
    }
  }

  // 4. ISO Date timestamp (e.g. 2024-03-12T14:30:00Z)
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = Math.min(Math.max(parseInt(isoMatch[2], 10), 1), 12);
    const d = Math.min(Math.max(parseInt(isoMatch[3], 10), 1), 31);
    if (y >= 1000 && y <= 9999) {
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // 5. Year fallback in text
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

    // Strict Pattern validations per scheme for Zenodo Invenio DataCite schema
    if (scheme === 'doi' && !/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/.test(idStr)) {
      continue;
    }
    if (scheme === 'url' && !/^https?:\/\/[^\s]+$/.test(idStr)) {
      continue;
    }
    if (scheme === 'issn' && !/^\d{4}-\d{3}[\dX]$/.test(idStr)) {
      continue;
    }
    if (scheme === 'isbn' && !/^[\d\-X]{10,17}$/.test(idStr)) {
      continue;
    }
    if (scheme === 'orcid' && !/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(idStr)) {
      continue;
    }
    if (scheme === 'pmid' && !/^\d+$/.test(idStr)) {
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
        creatorObj.affiliation = a.affiliation.trim().substring(0, 300);
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

  // Handle DOIs: External existing DOIs are routed to related_identifiers to prevent schema pattern mismatch
  if (metadata.doi && typeof metadata.doi === 'string') {
    const cleanDoi = metadata.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
    if (/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/.test(cleanDoi)) {
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
    const langMap: Record<string, string> = {
      en: 'eng', english: 'eng',
      fr: 'fra', french: 'fra',
      de: 'deu', german: 'deu',
      es: 'spa', spanish: 'spa',
      it: 'ita', italian: 'ita',
      pt: 'por', portuguese: 'por',
      ru: 'rus', russian: 'rus',
      zh: 'zho', chinese: 'zho',
      ja: 'jpn', japanese: 'jpn',
      ar: 'ara', arabic: 'ara',
      hi: 'hin', hindi: 'hin',
      ko: 'kor', korean: 'kor',
      nl: 'nld', dutch: 'nld',
      pl: 'pol', polish: 'pol',
      sv: 'swe', swedish: 'swe',
      tr: 'tur', turkish: 'tur',
      uk: 'ukr', ukrainian: 'ukr',
      vi: 'vie', vietnamese: 'vie'
    };
    if (langMap[lang]) lang = langMap[lang];
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

function isValidGeminiKey(key?: string | null): boolean {
  if (!key || typeof key !== 'string') return false;
  const cleaned = key.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (cleaned.length < 15) return false;
  if (/^(MY_GEMINI_API_KEY|YOUR_API_KEY|YOUR_GEMINI_KEY|PLACEHOLDER|NULL|UNDEFINED|MY_KEY)$/i.test(cleaned)) return false;
  if (cleaned.includes('MY_GEMINI_API_KEY')) return false;
  return true;
}

function extractGeminiApiKey(req: express.Request): string {
  const candidates = [
    req.body?.geminiApiKey,
    req.query?.geminiApiKey,
    req.header('X-Gemini-Api-Key'),
    req.headers?.['x-gemini-api-key'],
    process.env.GEMINI_API_KEY,
    process.env.VITE_GEMINI_API_KEY
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && isValidGeminiKey(c)) {
      return c.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim();
    }
  }
  return '';
}

const GEMINI_MODELS = [
  'gemini-3.7-flash',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-flash-latest',
  'gemini-3.1-flash-lite',
  'gemini-1.5-flash'
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
  let sawInvalidKey = false;
  const maxPoolPasses = 5;

  for (let pass = 0; pass < maxPoolPasses; pass++) {
    if (pass > 0) {
      // Exponential backoff with jitter on retry
      const backoffMs = Math.min(5000, 800 * Math.pow(1.6, pass) + Math.random() * 500);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }

    for (const modelName of GEMINI_MODELS) {
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout waiting for Gemini model ${modelName}`)), 40000)
        );
        const result = await Promise.race([
          ai.models.generateContent({
            model: modelName,
            contents: request.contents,
            config: request.config
          }),
          timeoutPromise
        ]) as any;
        if (result && (result.text || result.candidates)) return result;
      } catch (err: any) {
        lastErr = err;
        const status = err.status || err.statusCode || err.code;
        const msg = typeof err.message === 'string' ? err.message : JSON.stringify(err);
        
        const isInvalidKey = status === 401 || (msg && (
          msg.includes('API_KEY_INVALID') ||
          msg.includes('API key not valid') ||
          msg.includes('UNAUTHENTICATED') ||
          msg.includes('API_KEY_SERVICE_BLOCKED')
        ));

        if (isInvalidKey) {
          sawInvalidKey = true;
          break; // Don't keep hammering with an invalid key
        }

        const isTemporaryCapacity = status === 503 || status === 429 || status === 'UNAVAILABLE' || (msg && (
          msg.includes('503') ||
          msg.includes('429') ||
          msg.includes('UNAVAILABLE') ||
          msg.includes('RESOURCE_EXHAUSTED') ||
          msg.includes('high demand') ||
          msg.includes('high load') ||
          msg.includes('overloaded') ||
          msg.includes('capacity')
        ));

        if (isTemporaryCapacity) {
          // Add brief jitter before switching to the next fallback model
          await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 400));
        }
      }
    }
  }

  if (sawInvalidKey) {
    throw new Error('Invalid or unauthorized Gemini API key. Please verify your Gemini API key in Settings or the API key input.');
  }

  throw lastErr || new Error('All Gemini model attempts failed.');
}

function isJunkTitle(str: string): boolean {
  if (!str || typeof str !== 'string') return true;
  if (isGibberish(str)) return true;
  const trimmed = str.trim();
  if (trimmed.length < 4) return true;
  if (!/[a-zA-Z]{3,}/.test(trimmed)) return true;

  // TeX / pdfTeX / LaTeX engine metadata strings & binary markers
  if (/pdftex|pdflatex|tex\s*live|hyperref|pdfinfo|dvips|xetex|luatex|pdfpages|graphicx/i.test(trimmed)) {
    return true;
  }

  // Internal PDF font/stream markers
  if (/Identity-H|CIDInit|FontName|Helvetica|Times-Roman|Courier|ProcSet|Encoding|Type1|TrueType|Adobe|CoreGraphics|XObject|trailer|xref|startxref|obj\b|endobj\b|stream\b|endstream\b|PDF-1\.|CMap|CIDFont/i.test(trimmed)) {
    return true;
  }

  // Journal / Conference / Publisher banner headers
  if (/^(?:ieee\s+trans|acm\s+trans|proceedings\s+of|journal\s+of|international\s+conference|springer|elsevier|wiley|nature\s+publishing|nature\s+communications|science\s+advances|plos\s+one|frontiers\s+in|mdpi|cell\s+press|biomed\s+central|annual\s+review)/i.test(trimmed)) {
    return true;
  }

  // Volume / Issue / Page metadata
  if (/^(?:vol\.\s*\d+|volume\s+\d+|issue\s+\d+|no\.\s*\d+|pp\.\s*\d+|page\s+\d+|\d+\s+of\s+\d+|issn\s*[:\d-]+|isbn\s*[:\d-]+)/i.test(trimmed)) {
    return true;
  }

  // Preprint / Status headers
  if (/^(?:arxiv:\s*\d|biorxiv\s+preprint|medrxiv\s+preprint|chemrxiv|ssrn|under\s+review|preprint\.|manuscript\s+received|accepted\s+for\s+publication|draft\s+version)/i.test(trimmed)) {
    return true;
  }

  // Copyright / Downloaded lines
  if (/^(?:copyright\s+©?|all\s+rights\s+reserved|published\s+by|distributed\s+under|open\s+access|creative\s+commons|cc\s+by|downloaded\s+from|available\s+online\s+at)/i.test(trimmed)) {
    return true;
  }

  // URLs / DOIs
  if (/^(?:https?:\/\/|www\.|doi\s*:|10\.\d{4,9}\/)/i.test(trimmed)) {
    return true;
  }

  // Section headings mistaken for title
  if (/^(?:abstract|summary|introduction|keywords|index\s+terms|table\s+of\s+contents|references|acknowledgments|contents|appendix|conclusion|background|results|discussion)$/i.test(trimmed)) {
    return true;
  }

  // If > 55% non-alphanumeric
  const alphaChars = trimmed.replace(/[^a-zA-Z]/g, '').length;
  if (alphaChars < trimmed.length * 0.40) return true;

  return false;
}

function cleanTitleFromFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') return 'Research Paper';
  let name = filename.replace(/\.[a-zA-Z0-9]+$/i, '').trim();

  // Remove arXiv IDs: e.g., "2303.08774v1_", "2303.08774_"
  name = name.replace(/^\d{4}\.\d{4,5}(?:v\d+)?[-_]?/i, '');

  // Remove leading DOIs or dates: e.g., "10.1145_3534578_", "2023_05_12_"
  name = name.replace(/^10\.\d{4,9}[-_a-zA-Z0-9.]+[-_]/i, '');
  name = name.replace(/^\d{4}[-_]\d{2}[-_]\d{2}[-_]?/, '');

  // Remove leading random hashes: e.g. "a1b2c3d4e5f6_"
  name = name.replace(/^[a-f0-9]{10,}[-_]/i, '');

  // Replace separators with spaces
  name = name.replace(/[-_+]/g, ' ').replace(/%20/g, ' ');

  // Split CamelCase into words (e.g. DeepResidualLearning -> Deep Residual Learning)
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');

  // Collapse whitespace
  name = name.replace(/\s+/g, ' ').trim();

  // If name is generic
  if (!name || /^(?:document|paper|manuscript|download|untitled|file|main|fulltext|output)$/i.test(name)) {
    return 'Research Paper';
  }

  // Capitalize words properly (Title Case)
  return name.split(' ')
    .map(w => {
      if (/^(a|an|the|and|or|but|in|on|at|to|for|with|by|of|from|as|into|via)$/i.test(w)) {
        return w.toLowerCase();
      }
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ')
    .replace(/^([a-z])/, m => m.toUpperCase());
}

function cleanExtractedTitle(rawTitle: string, filename: string = ''): string {
  if (!rawTitle || typeof rawTitle !== 'string') {
    return cleanTitleFromFilename(filename);
  }

  let t = rawTitle.replace(/\r\n/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

  // Strip surrounding quotes, brackets, parentheses
  t = t.replace(/^["'“”‘`«\[(]+|["'“”’`»\])]+$/g, '').trim();

  // Strip leading "Title:" or "Paper Title:"
  t = t.replace(/^(?:paper\s+)?title\s*[:.-]\s*/i, '').trim();

  // Strip leading publisher / journal prefixes (e.g. "IEEE Transactions on PAMI: Deep Residual Learning")
  t = t.replace(/^(?:ieee\s+transactions\s+on[^\n:–-]+|proceedings\s+of[^\n:–-]+|arxiv:\s*\S+)\s*[:–-]\s*/i, '').trim();

  // Strip trailing publisher tags (e.g. "Deep Residual Learning - arXiv", "Deep Residual Learning | Nature")
  t = t.replace(/\s*[-–|]\s*(?:ieee|acm|springer|elsevier|arxiv|biorxiv|science|nature|wiley|plos).*$/i, '').trim();

  // Fix hyphenated line breaks (e.g., "Transformer- based" -> "Transformer-based")
  t = t.replace(/-\s+/g, '-');

  // Strip leading numbering (e.g. "1. Deep Residual Learning" or "Paper #123:")
  t = t.replace(/^(?:\d+\.|\d+\s*[-:]|paper\s*#?\d+[:\s])\s*/i, '').trim();

  if (isJunkTitle(t) || t.length < 5) {
    return cleanTitleFromFilename(filename);
  }

  if (t.length > 300) {
    t = t.substring(0, 300).trim();
  }

  return t || cleanTitleFromFilename(filename);
}

function sanitizeAuthorName(rawName: string): string {
  if (!rawName || typeof rawName !== 'string') return '';
  let n = rawName.trim();
  // Remove superscript numbers, symbols, footnotes: e.g. "John Doe1,2,*" or "Jane Smith†"
  n = n.replace(/[\d,*†‡§#]+$/g, '').replace(/^[\d,*†‡§#]+/g, '').trim();
  n = n.replace(/\s+[\d,*†‡§#]+(?=\s|$)/g, ' ').trim();
  // Remove email addresses attached
  n = n.replace(/\s*<[^>]+@?[^>]*>/g, '').replace(/\s*\S+@\S+/g, '').trim();
  // Remove trailing commas, semicolons
  n = n.replace(/[,;]+$/g, '').trim();

  // Filter out non-person words
  if (/^(?:Abstract|Introduction|Department|University|Institute|College|Faculty|Center|Laboratory|School|Hospital|Corporation|Inc|LLC|Ltd|IEEE|ACM|Springer|Elsevier|Nature|Science|Author|Authors|Member|Fellow|Student|Senior|Corresponding|Keywords|Index Terms|Table|Figure|Vol|Volume|Issue|Page|Preprint|ArXiv)$/i.test(n)) {
    return '';
  }
  if (n.length < 3 || n.length > 60) return '';
  if (!/[a-zA-Z]{2,}/.test(n)) return '';

  return n;
}

function isGibberish(text: string): boolean {
  if (!text || typeof text !== 'string') return true;
  if (text.includes('(cid:') || text.includes('\uFFFD')) return true;
  if (/pdftex|pdflatex|tex\s*live|hyperref|pdfinfo|dvips|xetex|luatex|pdfpages|graphicx|texlive|pdffonts/i.test(text)) return true;
  
  // Check for binary font garbage or high density of non-ASCII symbols
  const nonAsciiSymbols = text.match(/[^\x20-\x7E]/g);
  if (nonAsciiSymbols && nonAsciiSymbols.length > 2) return true;

  const clean = text.replace(/[^a-zA-Z0-9\s]/g, '');
  const alphaRatio = clean.length / Math.max(1, text.length);
  if (alphaRatio < 0.5 && text.length > 5) return true;

  const words = text.split(/\s+/);
  const gibberishWords = words.filter(w => /[^a-zA-Z]{2,}/.test(w) && !/^\d+$/.test(w));
  if (gibberishWords.length >= 2) return true;

  return false;
}

function cleanExtractedPdfText(text: string): string {
  if (!text || typeof text !== 'string') return '';
  const lines = text.split('\n');
  const cleanLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isGibberish(trimmed)) continue;
    if (/pdftex|pdflatex|tex\s*live|hyperref|pdfinfo|dvips|xetex|luatex|pdfpages|graphicx|texlive|pdffonts|producer|creator|creationdate/i.test(trimmed)) continue;
    if (/^(?:object|endobj|stream|endstream|trailer|xref|startxref)\b/i.test(trimmed)) continue;
    if (/[^\x20-\x7E]{2,}/.test(trimmed)) continue;
    cleanLines.push(trimmed);
  }
  const joined = cleanLines.join('\n');
  const nonAsciiCount = (joined.match(/[^\x20-\x7E]/g) || []).length;
  if (nonAsciiCount > 10 || /pdftex|tex\s*live/i.test(joined)) {
    return ''; // Discard heavily polluted extracted text
  }
  return joined;
}

function sanitizeMetadataResult(metadata: any, filename: string): any {
  const fallbackTitle = cleanTitleFromFilename(filename);
  
  if (!metadata || typeof metadata !== 'object') {
    metadata = {};
  }

  const isPolluted = (str: string) => {
    if (!str || typeof str !== 'string') return true;
    if (isGibberish(str)) return true;
    if (/pdftex|pdflatex|tex\s*live|texlive|pdfinfo|pdffonts|debian|hyperref|dvips|xetex|luatex|pdfpages|graphicx/i.test(str)) return true;
    if (str.includes('pdfTeX') || str.includes('TeX Live') || str.includes('Debian')) return true;
    return false;
  };

  // Title sanitization
  let rawTitle = typeof metadata.title === 'string' ? metadata.title : '';
  if (isPolluted(rawTitle)) {
    metadata.title = fallbackTitle;
  } else {
    const cleaned = cleanExtractedTitle(rawTitle, filename);
    metadata.title = cleaned && !isPolluted(cleaned) ? cleaned : fallbackTitle;
  }

  // Alternative title
  if (typeof metadata.alternativeTitle === 'string' && isPolluted(metadata.alternativeTitle)) {
    metadata.alternativeTitle = '';
  }

  // Abstract sanitization
  let rawAbstract = typeof metadata.abstract === 'string' ? metadata.abstract : '';
  if (isPolluted(rawAbstract) || rawAbstract.length < 15) {
    metadata.abstract = `${metadata.title}. Open-access research paper archived for long-term discovery and citation on Zenodo.`;
  }

  // Summary sanitization
  let rawSummary = typeof metadata.summary === 'string' ? metadata.summary : '';
  if (isPolluted(rawSummary) || rawSummary.length < 15) {
    metadata.summary = `${metadata.title}. Comprehensive research publication detailing methodology, evaluation, and empirical results.`;
  }

  // TLDR sanitization
  let rawTldr = typeof metadata.tldr === 'string' ? metadata.tldr : '';
  if (isPolluted(rawTldr) || rawTldr.length < 10) {
    metadata.tldr = `${metadata.title} - Open-access research paper published on Zenodo.`;
  }

  // Authors sanitization
  if (Array.isArray(metadata.authors)) {
    metadata.authors = metadata.authors.map((author: any) => {
      let name = typeof author === 'string' ? author : (author?.name || '');
      name = sanitizeAuthorName(name);
      if (!name || isPolluted(name) || /university|department|institute/i.test(name)) {
        name = '';
      }
      return {
        name: name || 'Lead Author',
        affiliation: typeof author?.affiliation === 'string' && !isPolluted(author.affiliation) ? author.affiliation.trim() : '',
        url: typeof author?.url === 'string' ? author.url.trim() : ''
      };
    }).filter((a: any) => a.name && a.name !== 'Lead Author' || metadata.authors.length === 1);
    if (metadata.authors.length === 0) {
      metadata.authors = [{ name: 'Lead Author', affiliation: '', url: '' }];
    }
  } else {
    metadata.authors = [{ name: 'Lead Author', affiliation: '', url: '' }];
  }

  // Key takeaways
  if (Array.isArray(metadata.keyTakeaways)) {
    metadata.keyTakeaways = metadata.keyTakeaways.filter((item: string) => item && typeof item === 'string' && !isPolluted(item));
  }
  if (!Array.isArray(metadata.keyTakeaways) || metadata.keyTakeaways.length === 0) {
    metadata.keyTakeaways = [
      `Comprehensive research findings and evaluation results for ${metadata.title}.`,
      'Open-access archival on Zenodo for long-term reproducibility and discovery.'
    ];
  }

  // Novelties
  if (Array.isArray(metadata.novelties)) {
    metadata.novelties = metadata.novelties.filter((item: string) => item && typeof item === 'string' && !isPolluted(item));
  }
  if (!Array.isArray(metadata.novelties) || metadata.novelties.length === 0) {
    metadata.novelties = [`Original methodology and contributions in ${metadata.title}.`];
  }

  // Long tail keywords
  if (Array.isArray(metadata.longTailKeywords)) {
    metadata.longTailKeywords = metadata.longTailKeywords.filter((item: string) => item && typeof item === 'string' && !isPolluted(item));
  }
  if (!Array.isArray(metadata.longTailKeywords) || metadata.longTailKeywords.length === 0) {
    metadata.longTailKeywords = [metadata.title.toLowerCase(), 'open access research', 'zenodo publication'];
  }

  // Glossary
  if (Array.isArray(metadata.glossary)) {
    metadata.glossary = metadata.glossary.filter((g: any) => g && g.term && typeof g.term === 'string' && !isPolluted(g.term) && (!g.definition || !isPolluted(g.definition)));
  } else {
    metadata.glossary = [];
  }

  // FAQ
  if (Array.isArray(metadata.faq)) {
    metadata.faq = metadata.faq.filter((f: any) => f && f.question && typeof f.question === 'string' && !isPolluted(f.question) && (!f.answer || !isPolluted(f.answer)));
  } else {
    metadata.faq = [
      {
        question: `What is the primary contribution of ${metadata.title}?`,
        answer: metadata.abstract || 'This paper presents novel methodologies and empirical findings.'
      }
    ];
  }

  // Misc string fields
  ['methodology', 'targetAudience', 'fundingInformation', 'journalName'].forEach(field => {
    if (metadata[field] && isPolluted(metadata[field])) {
      metadata[field] = '';
    }
  });

  return metadata;
}

function parseMetadataFromPdfText(text: string, filename: string = ''): any {
  const cleanText = safeString(text).replace(/\r\n/g, '\n').trim();
  const rawLines = cleanText.split('\n').map(l => l.trim()).filter(Boolean);
  
  // 1. Title Extraction
  let title = '';
  let titleLineEndIdx = 0;
  
  // Find non-junk lines in the first 25 lines
  const titleParts: string[] = [];
  for (let i = 0; i < Math.min(rawLines.length, 25); i++) {
    const line = rawLines[i];
    if (isJunkTitle(line)) continue;
    
    // Stop if we hit Abstract or Author Affiliation indicators
    if (/^(?:abstract|summary)\b/i.test(line)) break;
    if (/@|http:\/\/|https:\/\/|doi\.org/i.test(line)) break;
    if (/\b(?:university|department|institute|laboratory|faculty|college)\b/i.test(line) && titleParts.length > 0) {
      break;
    }
    
    titleParts.push(line);
    titleLineEndIdx = i;
    if (titleParts.join(' ').length > 60 && !line.endsWith('-')) {
      break;
    }
    if (titleParts.length >= 3) break;
  }

  const rawTitleJoined = titleParts.join(' ');
  title = cleanExtractedTitle(rawTitleJoined, filename);

  // 2. Abstract Extraction
  let abstract = '';
  const abstractMatch = cleanText.match(/(?:abstract|summary)\s*[:.\-—\s]\s*([\s\S]{50,4000}?)(?=\n\s*(?:1[\s.]+|1\.\s+introduction|introduction|keywords|index\s+terms|key\s+words|categories|background|\n\s*\n\s*[A-Z][a-z]+)|$)/i);
  if (abstractMatch) {
    abstract = abstractMatch[1]
      .replace(/\r\n/g, ' ')
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/-\s+/g, '')
      .trim();
  }
  if (!abstract) {
    const afterTitle = rawLines.slice(titleLineEndIdx + 1, titleLineEndIdx + 15).join(' ');
    if (afterTitle.length > 100) {
      abstract = afterTitle.substring(0, 500) + '...';
    } else {
      abstract = `${title}. Open-access scientific paper archived for long-term discovery and citation on Zenodo.`;
    }
  }

  // 3. Keywords Extraction
  const keywords: string[] = [];
  const kwMatch = cleanText.match(/(?:keywords|index\s+terms|key\s+words)\s*[:.\-—\s]\s*([^\n\r]{5,300})/i);
  if (kwMatch) {
    kwMatch[1].split(/[,;•|]/).forEach(k => {
      const cleaned = k.trim().replace(/^[-—*]\s*/, '');
      if (cleaned && cleaned.length > 2 && cleaned.length < 60 && !/^(keywords|index terms)$/i.test(cleaned)) {
        keywords.push(cleaned);
      }
    });
  }

  // 4. Authors Extraction
  const authors: any[] = [];
  const linesBetween = rawLines.slice(titleLineEndIdx + 1, Math.min(rawLines.length, titleLineEndIdx + 20));
  for (const line of linesBetween) {
    if (/^(?:abstract|summary)\b/i.test(line)) break;
    if (/@|https?:\/\/|doi\.org|\b(?:department|university|institute|laboratory|faculty|school|hospital|center|college|avenue|street|box|zip|usa|china|germany|france|canada|uk)\b/i.test(line)) {
      continue;
    }
    if (isJunkTitle(line)) continue;

    const candidateNames = line.split(/[,;&•]|\band\b/i);
    for (const rawName of candidateNames) {
      const cleanedName = sanitizeAuthorName(rawName);
      if (cleanedName && !authors.some(a => a.name.toLowerCase() === cleanedName.toLowerCase())) {
        authors.push({ name: cleanedName, affiliation: '', url: '' });
      }
    }
    if (authors.length >= 8) break;
  }

  if (authors.length === 0) {
    const fnAuthorMatch = filename.match(/^([A-Z][a-z]+)(?:_et_al|_and_|\s)/);
    if (fnAuthorMatch && !/^(Paper|Document|Manuscript|Download|Untitled|File)$/i.test(fnAuthorMatch[1])) {
      authors.push({ name: fnAuthorMatch[1], affiliation: '', url: '' });
    } else {
      authors.push({ name: 'Lead Author', affiliation: '', url: '' });
    }
  }

  // 5. Code and Data Links
  const linkMatches = cleanText.match(/https?:\/\/(?:github\.com|gitlab\.com|huggingface\.co|zenodo\.org|doi\.org|osf\.io)\/[^\s()<>,]+/gi);
  const codeLinks = linkMatches ? Array.from(new Set(linkMatches)).join(', ') : '';

  // 6. DOI or Identifiers
  const doiMatch = cleanText.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/);
  const identifiers = doiMatch ? [{ identifier: doiMatch[0], scheme: 'doi' }] : [];

  // 7. References
  const references: any[] = [];
  const refSectionMatch = cleanText.match(/(?:references|bibliography)\s*[:.\-—\s]\s*([\s\S]{100,5000})/i);
  if (refSectionMatch) {
    const refLines = refSectionMatch[1].split(/\n+/).map(l => l.trim()).filter(l => l.length > 20);
    refLines.slice(0, 10).forEach(ref => {
      references.push({ name: ref.replace(/^\[\d+\]\s*/, '') });
    });
  }

  // 8. Publication Date
  const dateMatch = cleanText.match(/(?:published|accepted|received|date)\s*[:.\-—]?\s*([a-zA-Z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[a-zA-Z]+\s+\d{4}|\d{4}-\d{2}-\d{2})/i);
  let pubDate = '';
  if (dateMatch) {
    pubDate = formatZenodoDate(dateMatch[1]);
  } else {
    const yearMatch = cleanText.match(/\b(20\d\d|19\d\d)\b/);
    pubDate = yearMatch ? `${yearMatch[1]}-01-01` : new Date().toISOString().split('T')[0];
  }

  return {
    title,
    alternativeTitle: '',
    authors,
    publicationDate: pubDate,
    fundingInformation: '',
    tldr: abstract ? (abstract.length > 200 ? abstract.substring(0, 200) + '...' : abstract) : `${title}. Open-access research data.`,
    abstract: abstract || 'Abstract extracted from uploaded PDF.',
    summary: abstract || 'Summary extracted from uploaded PDF.',
    keyTakeaways: [
      'Comprehensive research findings and evaluation results.',
      'Open-access archival on Zenodo for long-term reproducibility and discovery.'
    ],
    novelties: [
      `Original methodology and contributions in ${title}.`
    ],
    glossary: [],
    faq: [
      {
        question: `What is the primary contribution of ${title}?`,
        answer: abstract ? (abstract.length > 300 ? abstract.substring(0, 300) + '...' : abstract) : 'This paper presents novel methodologies and empirical findings.'
      }
    ],
    longTailKeywords: keywords.length > 0 ? keywords : [title.toLowerCase(), 'open access research', 'zenodo publication'],
    datasetsAndBenchmarks: [],
    practicalApplications: [],
    methodology: '',
    limitationsAndFutureWork: [],
    targetAudience: '',
    codeAndDataLinks: codeLinks,
    seoDescription: (title || 'Research paper').substring(0, 160),
    seoKeywords: keywords.length > 0 ? keywords : ['research', 'publication', 'zenodo', 'paper'],
    subjects: ['Multidisciplinary'],
    identifiers,
    references,
    license: 'cc-by-4.0',
    journalName: ''
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

      if (extractedText) {
        extractedText = cleanExtractedPdfText(extractedText);
        if (extractedText.length < 30) {
          extractedText = '';
        }
      }

      const apiKey = extractGeminiApiKey(req);
      let metadata: any = null;

      if (apiKey) {
        try {
          const ai = createGeminiClient(apiKey);
          const prompt = `You are an expert scientific publication indexer. Your task is to extract exact, high-fidelity metadata from the provided research paper document for publication on Zenodo.

CRITICAL INSTRUCTIONS FOR ACCURATE EXTRACTION:
1. TITLE:
   - Extract the TRUE substantive academic title of the research paper itself (e.g. "Deep Residual Learning for Image Recognition").
   - NEVER use journal, conference, or repository names (e.g. NEVER use "IEEE Transactions on...", "Proceedings of the ACM...", "Nature Communications", "bioRxiv", "arXiv:2305...", "NeurIPS 2023").
   - NEVER use running headers, page numbers, volume/issue numbers, copyright lines, or author names as the title.
   - If the title spans multiple lines in the document header, combine them into one single coherent title string.
   - If the document lacks a clear printed title, synthesize a clean, descriptive title from the document content and filename.

2. AUTHORS:
   - Extract ONLY human researcher/author names (e.g. "Kaiming He", "Xiangyu Zhang").
   - Do NOT include universities, departments, laboratories, journal names, or words like "Abstract", "Introduction", "Author", "Member", "Fellow" as author names.
   - For each author, extract their institutional affiliation (e.g. "Microsoft Research", "Stanford University") and ORCID URL / website if listed.

3. ABSTRACT & SUMMARY:
   - 'abstract': The complete, unaltered text of the paper's Abstract section.
   - 'summary': A comprehensive 2-3 paragraph summary of the paper's core contributions, methodology, and experimental results.

4. DATES & DOI:
   - 'publicationDate': The original publication, presentation, or preprint date in YYYY-MM-DD or YYYY format.
   - 'doi': The paper's official DOI if present (e.g. "10.1145/...").

Extract comprehensive metadata as a JSON object with these fields:
title: primary substantive title of the paper,
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
faq: array of objects, each with 'question' and 'answer' fields covering top questions answered by the paper. Provide up to 15 comprehensive questions and detailed answers (covering methodology, experimental setup, datasets, performance benchmarks, limitations, comparison with prior art, and real-world practical applications),
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
license: license if mentioned (e.g. 'cc-by-4.0'),
journalName: journal or conference name if mentioned.

If a field is not found, use an empty string or empty array as appropriate.
Return ONLY valid JSON.`;

          const parts: any[] = [{ text: prompt }];
          if (file.buffer && file.buffer.length > 0 && file.buffer.length < 15 * 1024 * 1024) {
            parts.push({
              inlineData: {
                data: file.buffer.toString('base64'),
                mimeType: 'application/pdf'
              }
            });
            if (file.originalname) {
              parts.push({ text: `Document Filename: ${file.originalname}` });
            }
          } else if (extractedText) {
            let paperContext = extractedText;
            if (extractedText.length > 45000) {
              const head = extractedText.substring(0, 35000);
              const tail = extractedText.substring(extractedText.length - 10000);
              paperContext = `${head}\n\n[... middle sections omitted for speed ...]\n\n${tail}`;
            }
            parts.push({ text: `Research Paper Text:\n\n${paperContext}` });
            if (file.originalname) {
              parts.push({ text: `Document Filename: ${file.originalname}` });
            }
          } else {
            parts.push({ text: `Filename: ${file.originalname || 'paper.pdf'}` });
          }

          console.log('DEBUG: Attempting Gemini AI extraction (multimodal PDF)...');
          try {
            const result = await generateContentWithFallback(ai, {
              contents: [{ role: 'user', parts }],
              config: { responseMimeType: "application/json" }
            });
            metadata = safeExtractJson(result.text, null);
          } catch (multimodalErr: any) {
            console.warn('Multimodal PDF extraction note, falling back to text-prompt AI extraction:', multimodalErr?.message || multimodalErr);
            if (extractedText && extractedText.length > 50) {
              let paperContext = extractedText;
              if (extractedText.length > 45000) {
                const head = extractedText.substring(0, 35000);
                const tail = extractedText.substring(extractedText.length - 10000);
                paperContext = `${head}\n\n[... middle sections omitted for speed ...]\n\n${tail}`;
              }
              const textParts = [
                { text: prompt },
                { text: `Research Paper Text Content:\n\n${paperContext}` },
                { text: `Document Filename: ${file.originalname || 'paper.pdf'}` }
              ];
              const textResult = await generateContentWithFallback(ai, {
                contents: [{ role: 'user', parts: textParts }],
                config: { responseMimeType: "application/json" }
              });
              metadata = safeExtractJson(textResult.text, null);
            }
          }
        } catch (aiErr: any) {
          console.warn('DEBUG: Gemini AI metadata extraction note (using text parser fallback):', aiErr?.message || aiErr);
        }
      }

      if (!metadata || isGibberish(metadata.title) || isJunkTitle(metadata.title) || /pdftex|pdflatex|tex\s*live|pdfinfo/i.test(metadata.title)) {
        console.log('DEBUG: Metadata missing or gibberish or pdftex title, extracting metadata directly from PDF text parser...');
        metadata = parseMetadataFromPdfText(extractedText, file.originalname || 'paper.pdf');
      } else {
        // Sanitize and clean up Gemini output to guarantee high quality
        metadata.title = cleanExtractedTitle(metadata.title, file.originalname || 'paper.pdf');
        if (isGibberish(metadata.title) || isJunkTitle(metadata.title) || /pdftex|pdflatex|tex\s*live|pdfinfo/i.test(metadata.title)) {
          metadata.title = cleanTitleFromFilename(file.originalname || 'paper.pdf');
        }

        if (metadata.abstract && isGibberish(metadata.abstract)) {
          metadata.abstract = '';
        }
        if (metadata.summary && isGibberish(metadata.summary)) {
          metadata.summary = '';
        }
        
        if (Array.isArray(metadata.authors) && metadata.authors.length > 0) {
          const cleanedAuthors: any[] = [];
          metadata.authors.forEach((author: any) => {
            let rawName = typeof author === 'string' ? author : (author?.name || '');
            let cleanedName = sanitizeAuthorName(rawName);
            if (!cleanedName && rawName && !/department|university|institute|springer|ieee/i.test(rawName)) {
              cleanedName = rawName.trim();
            }
            if (cleanedName) {
              cleanedAuthors.push({
                name: cleanedName,
                affiliation: (author?.affiliation || '').trim(),
                url: (author?.url || '').trim(),
                whoisBio: author?.whoisBio || '',
                whoisSources: Array.isArray(author?.whoisSources) ? author.whoisSources : []
              });
            }
          });
          metadata.authors = cleanedAuthors.length > 0 ? cleanedAuthors : [{ name: 'Lead Author', affiliation: '', url: '' }];
        } else {
          metadata.authors = [{ name: 'Lead Author', affiliation: '', url: '' }];
        }

        if (!metadata.abstract || metadata.abstract.length < 20) {
          if (extractedText) {
            const fallbackMeta = parseMetadataFromPdfText(extractedText, file.originalname || 'paper.pdf');
            if (fallbackMeta.abstract && fallbackMeta.abstract.length > 30) {
              metadata.abstract = fallbackMeta.abstract;
            }
          }
        }
      }

      const userName = (req.body.userName || '').trim();
      if (userName && metadata && metadata.authors) {
        if (metadata.authors.length === 0 || metadata.authors[0].name === 'Lead Author' || !metadata.authors[0].name) {
          if (metadata.authors.length > 0) {
            metadata.authors[0].name = userName;
          } else {
            metadata.authors = [{ name: userName, affiliation: '', url: '' }];
          }
        }
      }

      metadata = sanitizeMetadataResult(metadata, file.originalname || 'paper.pdf');

      return res.json(metadata);
    } catch (error: any) {
      console.error('Error in processing PDF:', error);
      let msg = error.message || (typeof error === 'string' ? error : 'An unexpected error occurred while processing the PDF.');
      
      // Fallback gracefully so user can continue
      try {
        const fallback = parseMetadataFromPdfText('', file?.originalname || 'Uploaded Research Paper.pdf');
        const userName = (req.body?.userName || '').trim();
        if (userName && fallback.authors && fallback.authors.length > 0 && (fallback.authors[0].name === 'Lead Author' || !fallback.authors[0].name)) {
          fallback.authors[0].name = userName;
        }
        return res.json(fallback);
      } catch {
        res.status(500).json({ error: msg });
      }
    }
  });

  app.post('/api/author-whois', async (req, res) => {
    try {
      const { name, affiliation, url } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'Author name is required.' });
      }

      const apiKey = extractGeminiApiKey(req);
      if (apiKey) {
        try {
          const ai = createGeminiClient(apiKey);
          const result = await fetchAuthorWhoisBio(ai, name, affiliation, url);
          return res.json(result);
        } catch (aiErr) {
          console.warn('Gemini WHOIS lookup failed, using heuristic bio:', aiErr);
        }
      }

      // Heuristic bio fallback
      const cleanName = String(name).trim();
      const aff = affiliation ? ` affiliated with ${affiliation}` : '';
      return res.json({
        whoisBio: `${cleanName}${aff}. Researcher in open-access scientific publications.`,
        sources: url ? [url] : []
      });
    } catch (err: any) {
      console.error('Error in /api/author-whois:', err);
      res.json({
        whoisBio: `${req.body?.name || 'Author'}${req.body?.affiliation ? ` (${req.body.affiliation})` : ''}.`,
        sources: []
      });
    }
  });

  app.post('/api/generate-glossary', async (req, res) => {
    try {
      const { title, abstract, summary, text } = req.body;
      const apiKey = extractGeminiApiKey(req);

      if (apiKey) {
        try {
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
          if (Array.isArray(glossary) && glossary.length > 0) {
            return res.json({ glossary });
          }
        } catch (aiErr) {
          console.warn('Gemini glossary generation failed, using heuristic fallback:', aiErr);
        }
      }

      // Heuristic fallback glossary
      const combined = `${title || ''} ${abstract || ''} ${summary || ''}`;
      const terms: { term: string; definition: string }[] = [];
      const acronymMatches = combined.match(/\b[A-Z]{2,6}\b/g);
      if (acronymMatches) {
        const unique = Array.from(new Set(acronymMatches)).slice(0, 6);
        unique.forEach(t => {
          terms.push({ term: t, definition: `Key algorithmic or domain concept used in the study of ${title || 'this research'}.` });
        });
      }
      if (terms.length === 0) {
        terms.push(
          { term: 'Methodology', definition: 'The systematic, theoretical analysis of the methods applied to a field of study.' },
          { term: 'Benchmark', definition: 'A standard or point of reference against which things may be compared or assessed.' }
        );
      }
      res.json({ glossary: terms });
    } catch (err: any) {
      console.error('Error in /api/generate-glossary:', err);
      res.json({ glossary: [] });
    }
  });

  app.post('/api/generate-faq', async (req, res) => {
    try {
      const { title, abstract, summary, count } = req.body;
      const targetCount = Math.min(20, Math.max(5, Number(count) || 20));
      const apiKey = extractGeminiApiKey(req);

      if (apiKey) {
        try {
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
          if (Array.isArray(faq) && faq.length > 0) {
            return res.json({ faq });
          }
        } catch (aiErr) {
          console.warn('Gemini FAQ generation failed, using heuristic fallback:', aiErr);
        }
      }

      // Heuristic fallback FAQ
      const paperTitle = title || 'this research';
      const defaultFaqs = [
        {
          question: `What is the primary contribution of ${paperTitle}?`,
          answer: abstract ? abstract.substring(0, 300) : `This paper presents novel methodologies and empirical findings in its respective domain.`
        },
        {
          question: 'What methodology or framework does this study apply?',
          answer: summary ? summary.substring(0, 300) : 'The study follows standard experimental evaluation protocols and analytical frameworks.'
        },
        {
          question: 'How can researchers reproduce or build upon these findings?',
          answer: 'The paper is published as an open-access resource with full metadata archived on Zenodo for long-term discovery and citation.'
        }
      ];
      res.json({ faq: defaultFaqs });
    } catch (err: any) {
      console.error('Error in /api/generate-faq:', err);
      res.json({ faq: [] });
    }
  });

  app.post('/api/generate-tldr', async (req, res) => {
    try {
      const { title, abstract, summary } = req.body;
      const apiKey = extractGeminiApiKey(req);

      if (apiKey) {
        try {
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
          if (data.tldr) {
            return res.json({ tldr: data.tldr });
          }
        } catch (aiErr) {
          console.warn('Gemini TL;DR generation failed, using heuristic fallback:', aiErr);
        }
      }

      // Heuristic fallback TL;DR
      const tldr = abstract ? abstract.split('.')[0] + '.' : `${title || 'Research paper'} presenting key findings and open-access data.`;
      res.json({ tldr });
    } catch (err: any) {
      console.error('Error in /api/generate-tldr:', err);
      res.json({ tldr: req.body?.title || '' });
    }
  });

  app.post('/api/generate-takeaways', async (req, res) => {
    try {
      const { title, abstract, summary } = req.body;
      const apiKey = extractGeminiApiKey(req);

      if (apiKey) {
        try {
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
          if (Array.isArray(takeaways) && takeaways.length > 0) {
            return res.json({ keyTakeaways: takeaways });
          }
        } catch (aiErr) {
          console.warn('Gemini takeaways generation failed, using heuristic fallback:', aiErr);
        }
      }

      res.json({
        keyTakeaways: [
          'Novel theoretical and empirical contributions presented.',
          'Comprehensive evaluation and baseline comparisons.',
          'Open-access archival on Zenodo ensures reproducibility.'
        ]
      });
    } catch (err: any) {
      console.error('Error in /api/generate-takeaways:', err);
      res.json({ keyTakeaways: [] });
    }
  });

  app.post('/api/generate-benchmarks', async (req, res) => {
    try {
      const { title, abstract, summary } = req.body;
      const apiKey = extractGeminiApiKey(req);

      if (apiKey) {
        try {
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
          if (Array.isArray(benchmarks) && benchmarks.length > 0) {
            return res.json({ datasetsAndBenchmarks: benchmarks });
          }
        } catch (aiErr) {
          console.warn('Gemini benchmarks generation failed:', aiErr);
        }
      }

      res.json({ datasetsAndBenchmarks: ['Standard experimental datasets and baseline evaluation metrics.'] });
    } catch (err: any) {
      console.error('Error in /api/generate-benchmarks:', err);
      res.json({ datasetsAndBenchmarks: [] });
    }
  });

  app.post('/api/generate-limitations', async (req, res) => {
    try {
      const { title, abstract, summary } = req.body;
      const apiKey = extractGeminiApiKey(req);

      if (apiKey) {
        try {
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
          if (Array.isArray(limitations) && limitations.length > 0) {
            return res.json({ limitationsAndFutureWork: limitations });
          }
        } catch (aiErr) {
          console.warn('Gemini limitations generation failed:', aiErr);
        }
      }

      res.json({
        limitationsAndFutureWork: [
          'Evaluations conducted under specified domain assumptions.',
          'Future work includes scaling to broader dataset distributions.'
        ]
      });
    } catch (err: any) {
      console.error('Error in /api/generate-limitations:', err);
      res.json({ limitationsAndFutureWork: [] });
    }
  });

  app.post('/api/generate-novelties', async (req, res) => {
    try {
      const { title, abstract, summary } = req.body;
      const apiKey = extractGeminiApiKey(req);

      if (apiKey) {
        try {
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
          if (Array.isArray(novelties) && novelties.length > 0) {
            return res.json({ novelties });
          }
        } catch (aiErr) {
          console.warn('Gemini novelties generation failed:', aiErr);
        }
      }

      res.json({
        novelties: [
          `Original research contribution for ${title || 'the study'}.`,
          'Integrated algorithmic framework and reproducible findings.'
        ]
      });
    } catch (err: any) {
      console.error('Error in /api/generate-novelties:', err);
      res.json({ novelties: [] });
    }
  });

  app.post('/api/generate-keywords', async (req, res) => {
    try {
      const { title, abstract, summary } = req.body;
      const apiKey = extractGeminiApiKey(req);

      if (apiKey) {
        try {
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
          if (Array.isArray(keywords) && keywords.length > 0) {
            return res.json({ keywords });
          }
        } catch (aiErr) {
          console.warn('Gemini keywords generation failed:', aiErr);
        }
      }

      const words = `${title || ''} ${abstract || ''}`
        .replace(/[^a-zA-Z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 4 && !/^(about|their|which|these|there|using|where|after|before|under)$/i.test(w));
      const uniqueWords = Array.from(new Set(words)).slice(0, 15);
      res.json({ keywords: uniqueWords.length > 0 ? uniqueWords : ['research', 'publication', 'zenodo'] });
    } catch (err: any) {
      console.error('Error in /api/generate-keywords:', err);
      res.json({ keywords: ['research', 'publication'] });
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
      let ZENODO_API_KEY = rawZenodoKey.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
      if (ZENODO_API_KEY.toLowerCase().startsWith('bearer ')) {
        ZENODO_API_KEY = ZENODO_API_KEY.substring(7).trim();
      }
      ZENODO_API_KEY = ZENODO_API_KEY.replace(/["']/g, '').trim();
      if (!ZENODO_API_KEY) {
        return res.status(401).send('Zenodo API Key is missing. Please enter your Zenodo Personal Access Token in API Settings.');
      }

      const originalName = file.originalname || 'paper.pdf';
      let safeFilename = originalName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/_+/g, '_')
        .trim();
      if (!safeFilename || safeFilename === '.pdf') {
        safeFilename = 'paper.pdf';
      }
      if (!safeFilename.toLowerCase().endsWith('.pdf')) {
        safeFilename = `${safeFilename}.pdf`;
      }
      
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
            const firstAuthorName = Array.isArray(metadata.authors) && metadata.authors[0]
              ? (typeof metadata.authors[0] === 'string' ? metadata.authors[0] : (metadata.authors[0]?.name || 'Research Author'))
              : 'Research Author';
            const safeCleanPayload = {
              title: (metadata.title || 'Untitled Research Paper').trim() || 'Untitled Research Paper',
              upload_type: 'publication',
              publication_type: 'article',
              description: buildZenodoDescriptionHTML(metadata) || '<p>Research paper uploaded via ZenUploader.</p>',
              publication_date: formatZenodoDate(metadata.publicationDate || metadata.publication_date),
              creators: [{ name: String(firstAuthorName).trim() || 'Research Author' }],
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
                console.warn(`DEBUG: Fallback deposition attempt on ${currentBaseUrl}:`, lastErrText);
              }
            } catch (fallbackNetErr: any) {
              console.warn(`DEBUG: Fallback network error on ${currentBaseUrl}:`, fallbackNetErr);
            }
          }

          // Try sandbox if production failed
          continue;
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
      let ZENODO_API_KEY = rawKey.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
      if (ZENODO_API_KEY.toLowerCase().startsWith('bearer ')) {
        ZENODO_API_KEY = ZENODO_API_KEY.substring(7).trim();
      }
      ZENODO_API_KEY = ZENODO_API_KEY.replace(/["']/g, '').trim();

      if (!depositionId || !ZENODO_API_KEY) {
        return res.status(400).send('Deposition ID and Zenodo API Key are required.');
      }

      const cleanMetadata = buildZenodoPayload(metadata);
      const baseUrls = ['https://zenodo.org/api/deposit/depositions', 'https://sandbox.zenodo.org/api/deposit/depositions'];
      let lastErrText = '';
      let updatedDep = null;

      for (const baseUrl of baseUrls) {
        try {
          const url = `${baseUrl}/${depositionId}`;
          const zRes = await fetch(url, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${ZENODO_API_KEY}`
            },
            body: JSON.stringify({ metadata: cleanMetadata })
          });

          if (zRes.ok) {
            updatedDep = await zRes.json();
            break;
          } else {
            lastErrText = await zRes.text();
            console.warn(`DEBUG: Zenodo update attempt on ${baseUrl} failed:`, zRes.status, lastErrText);

            if (zRes.status === 400) {
              const firstAuthorName = Array.isArray(metadata.authors) && metadata.authors[0]
                ? (typeof metadata.authors[0] === 'string' ? metadata.authors[0] : (metadata.authors[0]?.name || 'Research Author'))
                : 'Research Author';
              const safeCleanPayload = {
                title: (metadata.title || 'Untitled Research Paper').trim() || 'Untitled Research Paper',
                upload_type: 'publication',
                publication_type: 'article',
                description: buildZenodoDescriptionHTML(metadata) || '<p>Research paper uploaded via ZenUploader.</p>',
                publication_date: formatZenodoDate(metadata.publicationDate || metadata.publication_date),
                creators: [{ name: String(firstAuthorName).trim() || 'Research Author' }],
                access_right: 'open',
                license: 'cc-by-4.0'
              };

              try {
                const fallbackPutRes = await fetch(url, {
                  method: 'PUT',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${ZENODO_API_KEY}`
                  },
                  body: JSON.stringify({ metadata: safeCleanPayload })
                });

                if (fallbackPutRes.ok) {
                  updatedDep = await fallbackPutRes.json();
                  break;
                } else {
                  lastErrText = await fallbackPutRes.text();
                }
              } catch (fErr) {}
            }
          }
        } catch (e: any) {
          lastErrText = e.message || String(e);
        }
      }

      if (!updatedDep) {
        let detailMessage = lastErrText || 'Failed to update Zenodo deposition';
        try {
          const parsedErr = JSON.parse(lastErrText);
          if (parsedErr.errors && Array.isArray(parsedErr.errors) && parsedErr.errors.length > 0) {
            detailMessage = parsedErr.errors.map((e: any) => `${e.field || 'field'}: ${e.message}`).join('; ');
          } else if (parsedErr.message) {
            detailMessage = parsedErr.message;
          }
        } catch (e) {}
        return res.status(400).send(`Zenodo update failed: ${detailMessage}`);
      }

      res.json({ message: 'Zenodo paper updated successfully', data: updatedDep });
    } catch (err: any) {
      console.error('Error in /api/update-zenodo-paper:', err);
      res.status(500).send(err.message || 'Failed to update Zenodo deposition');
    }
  });

  app.get('/api/get-zenodo-papers', async (req, res) => {
    try {
      const rawKey = (req.query.zenodoApiKey as string) || (req.header('X-Zenodo-Api-Key') as string) || process.env.ZENODO_API_KEY || '';
      let ZENODO_API_KEY = rawKey.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
      if (ZENODO_API_KEY.toLowerCase().startsWith('bearer ')) {
        ZENODO_API_KEY = ZENODO_API_KEY.substring(7).trim();
      }
      ZENODO_API_KEY = ZENODO_API_KEY.replace(/["']/g, '').trim();

      if (!ZENODO_API_KEY) {
        return res.json([]);
      }

      const allDepositions: any[] = [];
      const baseUrls = ['https://zenodo.org/api/deposit/depositions?size=100', 'https://sandbox.zenodo.org/api/deposit/depositions?size=100'];

      for (const url of baseUrls) {
        try {
          const response = await fetch(url, {
            headers: {
              'Authorization': `Bearer ${ZENODO_API_KEY}`
            }
          });
          if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data)) {
              const isSandbox = url.includes('sandbox');
              data.forEach((item: any) => {
                allDepositions.push({
                  ...item,
                  environment: isSandbox ? 'sandbox' : 'production'
                });
              });
            }
          }
        } catch (netErr) {
          console.warn(`Failed to fetch from ${url}:`, netErr);
        }
      }

      res.json(allDepositions);
    } catch (err: any) {
      console.error('Error fetching Zenodo papers:', err);
      res.status(500).send(err.message || 'Failed to fetch Zenodo depositions');
    }
  });

  app.post('/api/delete-zenodo-paper', express.json(), async (req, res) => {
    try {
      const { depositionId, zenodoApiKey } = req.body;
      const rawKey = zenodoApiKey || (req.header('X-Zenodo-Api-Key') as string) || process.env.ZENODO_API_KEY || '';
      let ZENODO_API_KEY = rawKey.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
      if (ZENODO_API_KEY.toLowerCase().startsWith('bearer ')) {
        ZENODO_API_KEY = ZENODO_API_KEY.substring(7).trim();
      }
      ZENODO_API_KEY = ZENODO_API_KEY.replace(/["']/g, '').trim();

      if (!depositionId || !ZENODO_API_KEY) {
        return res.status(400).send('Deposition ID and Zenodo API Key are required.');
      }

      const baseUrls = ['https://zenodo.org/api/deposit/depositions', 'https://sandbox.zenodo.org/api/deposit/depositions'];
      let deleted = false;
      let lastErrTxt = '';

      for (const baseUrl of baseUrls) {
        try {
          const url = `${baseUrl}/${depositionId}`;
          const zRes = await fetch(url, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${ZENODO_API_KEY}`
            }
          });
          if (zRes.ok || zRes.status === 404 || zRes.status === 204) {
            deleted = true;
            break;
          } else {
            lastErrTxt = await zRes.text();
          }
        } catch (e: any) {
          lastErrTxt = e.message || String(e);
        }
      }

      if (!deleted && lastErrTxt && !lastErrTxt.includes('404')) {
        console.warn('Zenodo deletion notice:', lastErrTxt);
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
