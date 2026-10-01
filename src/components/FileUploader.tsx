import React, { useState, useEffect, useRef } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../lib/db';
import { 
  Upload, CheckCircle2, Loader2, AlertCircle, CloudUpload, Key, 
  Plus, Trash2, Globe, FileText, Tag, BookOpen, HelpCircle, 
  Search, ExternalLink, Sparkles, UserCheck, FolderOpen, X, 
  RotateCcw, ArrowUpRight, Check, Rocket, Award, Copy, ChevronDown, ChevronUp,
  ShieldCheck
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { googleSignIn } from '../auth';
import { User } from 'firebase/auth';

function sanitizeHeader(val?: string): string {
  if (!val || typeof val !== 'string') return '';
  return val.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

async function safeJsonParse(response: Response): Promise<{ ok: boolean; status: number; data: any; text: string }> {
  let text = '';
  try {
    text = await response.text();
  } catch (err: any) {
    text = '';
  }
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {}
  }
  return {
    ok: response.ok,
    status: response.status,
    data,
    text
  };
}

function getSafeFileName(rawFile?: any): string {
  if (!rawFile) return 'document.pdf';
  const rawName = (typeof rawFile === 'object' && rawFile !== null && 'name' in rawFile && rawFile.name)
    ? String(rawFile.name)
    : (typeof rawFile === 'string' ? rawFile : 'document.pdf');
  try {
    let cleanName = rawName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_+/g, '_')
      .trim();
    if (!cleanName || cleanName === '.pdf') {
      return 'document.pdf';
    }
    if (!cleanName.toLowerCase().endsWith('.pdf')) {
      cleanName = `${cleanName}.pdf`;
    }
    return cleanName;
  } catch (e) {
    return 'document.pdf';
  }
}

function formatUrlDisplay(urlStr: any): string {
  if (!urlStr || typeof urlStr !== 'string') return 'Source';
  const trimmed = urlStr.trim();
  try {
    const match = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?([^\/\s?#:]+)/i);
    if (match && match[1]) {
      return match[1];
    }
  } catch (e) {}
  return trimmed.length > 25 ? trimmed.substring(0, 25) + '...' : trimmed || 'Source';
}

function getSafeHref(urlStr: any): string {
  if (!urlStr || typeof urlStr !== 'string') return '#';
  const trimmed = urlStr.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  try {
    if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(trimmed)) return `https://${trimmed}`;
  } catch (e) {}
  return '#';
}

function isGibberish(str: string): boolean {
  if (!str || typeof str !== 'string') return true;
  const trimmed = str.trim();
  if (trimmed.length < 3) return true;
  if (!/[\p{L}]/u.test(trimmed)) return true;
  const letters = trimmed.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return true;
  return false;
}

function isJunkTitle(str: string): boolean {
  if (!str || typeof str !== 'string') return true;
  if (isGibberish(str)) return true;
  const trimmed = str.trim();
  if (trimmed.length < 3) return true;
  if (!/[\p{L}]/u.test(trimmed)) return true;

  // TeX / pdfTeX / LaTeX engine metadata strings & binary markers
  if (/^(?:pdftex|pdflatex|tex\s*live|hyperref|pdfinfo|dvips|xetex|luatex|pdfpages|graphicx)$/i.test(trimmed)) {
    return true;
  }

  // Internal PDF font/stream markers
  if (/^(?:Identity-H|CIDInit|FontName|ProcSet|Encoding|Type1|TrueType|Adobe|CoreGraphics|XObject|trailer|xref|startxref|obj\b|endobj\b|stream\b|endstream\b|PDF-1\.|CMap|CIDFont)$/i.test(trimmed)) {
    return true;
  }

  // Standalone Journal / Conference / Publisher banner headers
  if (/^(?:ieee\s+transactions\s+on[^\n:–-]+|proceedings\s+of\s+the[^\n:–-]+|springer|elsevier|wiley|nature\s+publishing\s+group|nature\s+communications|science\s+advances|plos\s+one|frontiers\s+in\s+\w+|mdpi|cell\s+press|biomed\s+central|annual\s+reviews?)$/i.test(trimmed)) {
    return true;
  }

  // Standalone Volume / Issue / Page metadata
  if (/^(?:vol\.\s*\d+|volume\s+\d+|issue\s+\d+|no\.\s*\d+|pp\.\s*\d+(?:-\d+)?|page\s+\d+|\d+\s+of\s+\d+|issn\s*[:\d-]+|isbn\s*[:\d-]+)$/i.test(trimmed)) {
    return true;
  }

  // Standalone Preprint / Status headers
  if (/^(?:arxiv:\s*\d{4}\.\d{4,5}(?:v\d+)?|biorxiv\s+preprint|medrxiv\s+preprint|chemrxiv|ssrn|under\s+review|preprint\.|manuscript\s+received|accepted\s+for\s+publication|draft\s+version)$/i.test(trimmed)) {
    return true;
  }

  // Standalone Copyright / Downloaded lines
  if (/^(?:copyright\s+©?.*|all\s+rights\s+reserved.*|published\s+by\s+.*|distributed\s+under\s+.*|open\s+access|creative\s+commons\s+.*|cc\s+by\s+.*|downloaded\s+from\s+.*|available\s+online\s+at\s+.*)$/i.test(trimmed) && trimmed.length < 100) {
    return true;
  }

  // Standalone URLs / DOIs
  if (/^(?:https?:\/\/\S+|www\.\S+|doi\s*:\s*10\.\d{4,9}\/\S+|10\.\d{4,9}\/\S+)$/i.test(trimmed)) {
    return true;
  }

  // Section headings mistaken for title
  if (/^(?:abstract|summary|introduction|keywords|index\s+terms|table\s+of\s+contents|references|acknowledgments|contents|appendix|conclusion|background|results|discussion)$/i.test(trimmed)) {
    return true;
  }

  const wordChars = trimmed.replace(/[^\p{L}\p{N}]/gu, '').length;
  if (wordChars < trimmed.length * 0.25) return true;

  return false;
}

function cleanTitleFromFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') return 'Research Paper';
  let name = filename.replace(/\.[a-zA-Z0-9]+$/i, '').trim();
  name = name.replace(/^\d{4}\.\d{4,5}(?:v\d+)?[-_]?/i, '');
  name = name.replace(/^10\.\d{4,9}[-_a-zA-Z0-9.]+[-_]/i, '');
  name = name.replace(/^\d{4}[-_]\d{2}[-_]\d{2}[-_]?/, '');
  name = name.replace(/^[a-f0-9]{10,}[-_]/i, '');
  name = name.replace(/[-_+]/g, ' ').replace(/%20/g, ' ');
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  name = name.replace(/\s+/g, ' ').trim();

  if (!name || /^(?:document|paper|manuscript|download|untitled|file|main|fulltext|output)$/i.test(name)) {
    return 'Research Paper';
  }

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
  t = t.replace(/^["'“”‘`«\[(]+|["'“”’`»\])]+$/g, '').trim();
  t = t.replace(/^(?:paper\s+)?title\s*[:.-]\s*/i, '').trim();
  t = t.replace(/^(?:ieee\s+transactions\s+on[^\n:–-]+|proceedings\s+of[^\n:–-]+|arxiv:\s*\S+)\s*[:–-]\s*/i, '').trim();
  t = t.replace(/\s*[-–|]\s*(?:ieee|acm|springer|elsevier|arxiv|biorxiv|science|nature|wiley|plos).*$/i, '').trim();
  t = t.replace(/-\s+/g, '-');
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
  n = n.replace(/[\d,*†‡§#]+$/g, '').replace(/^[\d,*†‡§#]+/g, '').trim();
  n = n.replace(/\s+[\d,*†‡§#]+(?=\s|$)/g, ' ').trim();
  n = n.replace(/\s*<[^>]+@?[^>]*>/g, '').replace(/\s*\S+@\S+/g, '').trim();
  n = n.replace(/[,;]+$/g, '').trim();

  if (/^(?:Abstract|Introduction|Department|University|Institute|College|Faculty|Center|Laboratory|School|Hospital|Corporation|Inc|LLC|Ltd|IEEE|ACM|Springer|Elsevier|Nature|Science|Author|Authors|Member|Fellow|Student|Senior|Corresponding|Keywords|Index Terms|Table|Figure|Vol|Volume|Issue|Page|Preprint|ArXiv)$/i.test(n)) {
    return '';
  }
  if (n.length < 3 || n.length > 60) return '';
  if (!/[a-zA-Z]{2,}/.test(n)) return '';

  return n;
}

function parseMetadataFromBrowserBuffer(buffer: ArrayBuffer, filename: string = 'paper.pdf'): any {
  let extractedText = '';
  try {
    const bytes = new Uint8Array(buffer);
    const binaryStr = Array.from(bytes.subarray(0, Math.min(bytes.length, 500000)))
      .map(b => String.fromCharCode(b))
      .join('');
    
    const textBlocks: string[] = [];
    const matches = binaryStr.match(/\(([^()\r\n]{2,})\)/g);
    if (matches) {
      for (const m of matches) {
        const cleaned = m.slice(1, -1).replace(/\\([0-7]{3}|[()\\nrtb])/g, ' ').trim();
        if (cleaned.length >= 2 && /[\p{L}\p{N}]/u.test(cleaned) && !isJunkTitle(cleaned)) {
          textBlocks.push(cleaned);
        }
      }
    }
    extractedText = textBlocks.join(' ').replace(/\s+/g, ' ').trim();
  } catch (e) {
    console.warn('Browser fallback binary extraction warning:', e);
  }

  const cleanText = (extractedText || '').replace(/\r\n/g, '\n').trim();
  const rawLines = cleanText.split('\n').map(l => l.trim()).filter(Boolean);

  let title = '';
  let titleLineEndIdx = 0;
  
  const titleParts: string[] = [];
  for (let i = 0; i < Math.min(rawLines.length, 25); i++) {
    const line = rawLines[i];
    if (isJunkTitle(line)) continue;
    if (/^(?:abstract|summary)\b/i.test(line)) break;
    if (/@|http:\/\/|https:\/\/|doi\.org/i.test(line)) break;
    if (/\b(?:university|department|institute|laboratory|faculty|college)\b/i.test(line) && titleParts.length > 0) {
      break;
    }
    titleParts.push(line);
    titleLineEndIdx = i;
    if (titleParts.join(' ').length > 60 && !line.endsWith('-')) break;
    if (titleParts.length >= 3) break;
  }

  title = cleanExtractedTitle(titleParts.join(' '), filename);

  let abstract = '';
  const abstractMatch = cleanText.match(/(?:abstract|summary)\s*[:.\-—\s]\s*([\s\S]{50,4000}?)(?=\n\s*(?:1[\s.]+|1\.\s+introduction|introduction|keywords|index\s+terms|key\s+words|categories|background|\n\s*\n\s*[A-Z][a-z]+)|$)/i);
  if (abstractMatch) {
    abstract = abstractMatch[1].replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (!abstract) {
    const afterTitle = rawLines.slice(titleLineEndIdx + 1, titleLineEndIdx + 15).join(' ');
    if (afterTitle.length > 100) {
      abstract = afterTitle.substring(0, 500) + '...';
    } else {
      abstract = `${title}. Open-access scientific paper archived for long-term discovery and citation on Zenodo.`;
    }
  }

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

  const doiMatch = cleanText.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/);
  const identifiers = doiMatch ? [{ identifier: doiMatch[0], scheme: 'doi' }] : [];

  const yearMatch = cleanText.match(/\b(20\d\d|19\d\d)\b/);
  const publicationDate = yearMatch ? `${yearMatch[1]}-01-01` : new Date().toISOString().split('T')[0];

  return {
    title,
    alternativeTitle: '',
    authors,
    publicationDate,
    fundingInformation: '',
    tldr: abstract ? (abstract.length > 200 ? abstract.substring(0, 200) + '...' : abstract) : `${title}. Open-access research data.`,
    abstract,
    summary: abstract,
    keyTakeaways: ['Open-access research contribution', 'Peer-reviewed methodology & findings'],
    novelties: [`Scientific methodology and contributions in ${title}`],
    glossary: [],
    faq: [],
    longTailKeywords: keywords.length > 0 ? keywords : [title.toLowerCase(), 'research paper', 'zenodo publication'],
    datasetsAndBenchmarks: [],
    practicalApplications: [],
    methodology: '',
    limitationsAndFutureWork: [],
    targetAudience: '',
    codeAndDataLinks: '',
    seoDescription: (title || 'Research paper').substring(0, 160),
    seoKeywords: keywords.length > 0 ? keywords : ['research', 'publication', 'paper'],
    subjects: ['Multidisciplinary'],
    identifiers,
    references: [],
    license: 'cc-by-4.0',
    journalName: '',
    notice: 'Metadata extracted directly from document structure. You can review and refine all fields below before uploading to Zenodo.'
  };
}

function getFileCacheKey(targetFile: any): string {
  if (!targetFile) return '';
  const name = (typeof targetFile === 'object' && targetFile.name) ? String(targetFile.name) : String(targetFile);
  const size = (typeof targetFile === 'object' && targetFile.size) ? targetFile.size : 0;
  return `zen_cache_${name}_${size}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getCachedMetadata(targetFile: any): any | null {
  try {
    const key = getFileCacheKey(targetFile);
    if (!key) return null;
    const cached = localStorage.getItem(key);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && (parsed.title || parsed.abstract)) return parsed;
    }
  } catch (e) {}
  return null;
}

function setCachedMetadata(targetFile: any, metadata: any) {
  try {
    const key = getFileCacheKey(targetFile);
    if (!key || !metadata) return;
    localStorage.setItem(key, JSON.stringify(metadata));
  } catch (e) {}
}

export default function FileUploader({ user, onUploadSuccess }: { user: User | null; onUploadSuccess?: () => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const apiKeysRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const googleUserName = user?.displayName || (user?.email ? user.email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '');

  // Persistent author profile state
  const [savedAuthorProfile, setSavedAuthorProfile] = useState<{ name: string; affiliation: string; url: string; whoisBio?: string } | null>(null);
  const [savingAuthorProfile, setSavingAuthorProfile] = useState(false);
  const [authorProfileSavedMsg, setAuthorProfileSavedMsg] = useState(false);

  // Upload and Metadata states
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isUploadingToZenodo, setIsUploadingToZenodo] = useState(false);
  const [editableMetadata, setEditableMetadata] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [zenodoReceipt, setZenodoReceipt] = useState<any>(null);
  const [copiedDoi, setCopiedDoi] = useState(false);
  const [copiedCitation, setCopiedCitation] = useState<string | null>(null);

  // Settings & Authentication states
  const [zenodoApiKey, setZenodoApiKey] = useState<string>('');
  const [zenodoEnv, setZenodoEnv] = useState<'auto' | 'production' | 'sandbox'>('auto');
  const [geminiApiKey, setGeminiApiKey] = useState<string>('');
  const [savingKey, setSavingKey] = useState(false);
  const [keysSaved, setKeysSaved] = useState(false);
  const [verifyingKey, setVerifyingKey] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<{ success?: boolean; message?: string; error?: string } | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [showApiSettings, setShowApiSettings] = useState(false);
  const [authErrorInfo, setAuthErrorInfo] = useState<{
    is403: boolean;
    isIpRestricted?: boolean;
    message: string;
  } | null>(null);

  // Generation loading states
  const [loadingWhoisIndex, setLoadingWhoisIndex] = useState<number | null>(null);
  const [enrichingAll, setEnrichingAll] = useState(false);
  const [enrichSuccessMsg, setEnrichSuccessMsg] = useState(false);
  const [generatingSection, setGeneratingSection] = useState<string | null>(null);
  const hasAutoEnrichedTitleRef = useRef<string | null>(null);

  // Active section tab in reviewer ('all_combined' allows viewing all generated sections on one single page)
  const [activeReviewTab, setActiveReviewTab] = useState<'all_combined' | 'general' | 'insights' | 'science' | 'glossary_faq' | 'seo_deploy'>('all_combined');

  const applySavedProfile = (metadata: any) => {
    if (!savedAuthorProfile || !metadata || !metadata.authors) return metadata;
    const authors = [...metadata.authors];
    if (authors.length > 0 && (authors[0].name === 'Lead Author' || !authors[0].name || authors[0].name === googleUserName)) {
      authors[0] = {
        name: savedAuthorProfile.name || authors[0].name,
        affiliation: savedAuthorProfile.affiliation || authors[0].affiliation || '',
        url: savedAuthorProfile.url || authors[0].url || '',
        whoisBio: savedAuthorProfile.whoisBio || authors[0].whoisBio || ''
      };
    } else if (authors.length === 0 && savedAuthorProfile.name) {
      authors.push({
        name: savedAuthorProfile.name,
        affiliation: savedAuthorProfile.affiliation || '',
        url: savedAuthorProfile.url || '',
        whoisBio: savedAuthorProfile.whoisBio || ''
      });
    }
    return { ...metadata, authors };
  };

  useEffect(() => {
    loadZenodoApiKey(user?.uid);
    loadPermanentAuthorProfile(user?.uid);
  }, [user]);

  const loadPermanentAuthorProfile = async (uid?: string) => {
    try {
      let profile: any = null;
      const localProfile = localStorage.getItem('zenuploader_saved_author_profile');
      if (localProfile) {
        try { profile = JSON.parse(localProfile); } catch (e) {}
      }
      if (uid) {
        const docRef = doc(db, 'users', uid, 'profile', 'authorProfile');
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const cloudData = docSnap.data();
          if (cloudData && cloudData.name) {
            profile = cloudData;
            localStorage.setItem('zenuploader_saved_author_profile', JSON.stringify(cloudData));
          }
        }
      }
      if (profile) {
        setSavedAuthorProfile(profile);
      }
    } catch (err) {
      console.error('Failed to load permanent author profile:', err);
    }
  };

  const persistPermanentAuthorProfile = async (profileData: { name: string; affiliation: string; url: string; whoisBio?: string }) => {
    try {
      setSavingAuthorProfile(true);
      localStorage.setItem('zenuploader_saved_author_profile', JSON.stringify(profileData));
      setSavedAuthorProfile(profileData);
      if (user && user.uid) {
        const docRef = doc(db, 'users', user.uid, 'profile', 'authorProfile');
        await setDoc(docRef, profileData, { merge: true });
      }
      setAuthorProfileSavedMsg(true);
      setTimeout(() => setAuthorProfileSavedMsg(false), 3500);
    } catch (err) {
      console.error('Failed to save permanent author profile:', err);
      setError('Failed to save permanent author profile.');
    } finally {
      setSavingAuthorProfile(false);
    }
  };

  const loadZenodoApiKey = async (uid?: string) => {
    try {
      let zKey = localStorage.getItem('zenodo_api_key') || '';
      let zEnv = (localStorage.getItem('zenodo_env') as any) || 'auto';
      let gKey = localStorage.getItem('gemini_api_key') || '';
      if (uid) {
        const docRef = doc(db, 'users', uid, 'settings', 'zenodo');
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data.zenodoApiKey) zKey = data.zenodoApiKey;
          if (data.zenodoEnv) zEnv = data.zenodoEnv;
          if (data.geminiApiKey) gKey = data.geminiApiKey;
        }
      }
      setZenodoApiKey(zKey);
      setZenodoEnv(zEnv);
      setGeminiApiKey(gKey);
    } catch (err) {
      console.error('Failed to load API Keys:', err);
    }
  };

  const saveApiKeys = async () => {
    setSavingKey(true);
    try {
      localStorage.setItem('zenodo_api_key', zenodoApiKey);
      localStorage.setItem('zenodo_env', zenodoEnv);
      localStorage.setItem('gemini_api_key', geminiApiKey);
      if (user && user.uid) {
        const docRef = doc(db, 'users', user.uid, 'settings', 'zenodo');
        await setDoc(docRef, { zenodoApiKey, zenodoEnv, geminiApiKey }, { merge: true });
      }
      setKeysSaved(true);
      setTimeout(() => setKeysSaved(false), 3000);
    } catch (err) {
      console.error('Failed to save API Keys:', err);
      setError('Failed to save API Keys.');
    } finally {
      setSavingKey(false);
    }
  };

  const handleVerifyZenodoToken = async () => {
    if (!zenodoApiKey.trim()) {
      setVerifyStatus({ error: 'Please enter your Zenodo Personal Access Token first.' });
      return;
    }
    setVerifyingKey(true);
    setVerifyStatus(null);
    try {
      const res = await fetch('/api/verify-zenodo-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zenodoApiKey, zenodoEnv })
      });
      const { ok, data } = await safeJsonParse(res);
      if (ok && data?.valid) {
        setVerifyStatus({ success: true, message: data.message });
      } else {
        setVerifyStatus({ error: data?.error || 'Failed to verify Zenodo token.' });
      }
    } catch (err: any) {
      setVerifyStatus({ error: err?.message || 'Network error verifying Zenodo token.' });
    } finally {
      setVerifyingKey(false);
    }
  };

  const handleLogin = async () => {
    if (signingIn) return;
    setSigningIn(true);
    setError(null);
    try {
      const res = await googleSignIn();
      if (!res.success && res.error) {
        if (!res.error.includes('cancelled') && !res.error.includes('closed')) {
          setError(res.error);
        }
      }
    } catch (err: any) {
      console.warn('Login note:', err?.message || err);
    } finally {
      setSigningIn(false);
    }
  };

  // Listen to external PaperList load events
  useEffect(() => {
    const handleLoadPaper = (e: any) => {
      let data = e.detail?.metadata || e.detail;
      if (data) {
        data = applySavedProfile(data);
        setEditableMetadata(data);
        setError(null);
        setZenodoReceipt(null);
        setIsProcessing(false);
        setIsUploadingToZenodo(false);
        const topEl = document.getElementById('uploader-top') || document.getElementById('pdf-file-picker');
        topEl?.scrollIntoView({ behavior: 'smooth' });
      }
    };

    const handleClearDocumentEvent = () => {
      handleStartOver();
    };

    window.addEventListener('zenuploader_load_paper', handleLoadPaper);
    window.addEventListener('zenuploader_clear_document', handleClearDocumentEvent);

    return () => {
      window.removeEventListener('zenuploader_load_paper', handleLoadPaper);
      window.removeEventListener('zenuploader_clear_document', handleClearDocumentEvent);
    };
  }, []);

  const savePaperToHistory = async (metadata: any, status: string = 'processed', receipt: any = null) => {
    const rawDocId = receipt?.depositionId || receipt?.record_id || receipt?.id || Date.now();
    const newDocId = String(rawDocId).replace(/[^a-zA-Z0-9_-]/g, '_') || `paper_${Date.now()}`;
    const depositionId = receipt?.depositionId || receipt?.id || (status === 'uploaded' ? newDocId : undefined);
    const zenodoDoi = receipt?.doi || metadata?.doi || undefined;
    const environment = receipt?.environment || (receipt?.doi?.includes('5072') ? 'sandbox' : 'production');
    const zenodoUrl = receipt?.links?.html || receipt?.links?.record_html || (depositionId ? `https://${environment === 'sandbox' ? 'sandbox.' : ''}zenodo.org/deposit/${depositionId}` : undefined);

    const title = metadata?.title || 'Untitled Research Paper';
    const normTitle = title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

    let resolvedDocId = newDocId;
    try {
      const localUploads = JSON.parse(localStorage.getItem('zenuploader_local_uploads') || '[]');
      const existingIdx = localUploads.findIndex((item: any) => {
        if (depositionId && item.zenodoRecordId === String(depositionId)) return true;
        if (item.id === newDocId) return true;
        const itemTitle = (item.title || item.metadata?.title || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
        return itemTitle === normTitle && normTitle.length > 4;
      });

      if (existingIdx !== -1) {
        resolvedDocId = localUploads[existingIdx].id;
        localUploads[existingIdx] = {
          ...localUploads[existingIdx],
          title: title,
          metadata: metadata,
          status: status === 'uploaded' ? 'uploaded' : localUploads[existingIdx].status,
          zenodoRecordId: depositionId ? String(depositionId) : localUploads[existingIdx].zenodoRecordId,
          zenodoDoi: zenodoDoi ? String(zenodoDoi) : localUploads[existingIdx].zenodoDoi,
          zenodoUrl: zenodoUrl ? String(zenodoUrl) : localUploads[existingIdx].zenodoUrl,
          environment: environment
        };
      } else {
        const paperObj = {
          id: resolvedDocId,
          title: title,
          metadata: metadata,
          status: status,
          createdAt: new Date().toISOString(),
          zenodoRecordId: depositionId ? String(depositionId) : undefined,
          zenodoDoi: zenodoDoi ? String(zenodoDoi) : undefined,
          zenodoUrl: zenodoUrl ? String(zenodoUrl) : undefined,
          environment: environment
        };
        localUploads.unshift(paperObj);
      }
      localStorage.setItem('zenuploader_local_uploads', JSON.stringify(localUploads));
    } catch (e) {
      console.warn('Failed to write to localStorage:', e);
    }

    if (user && user.uid) {
      try {
        const uploadRef = doc(db, 'users', user.uid, 'uploads', resolvedDocId);
        await setDoc(uploadRef, {
          title: title,
          metadata: metadata,
          status: status,
          createdAt: new Date().toISOString(),
          zenodoRecordId: depositionId ? String(depositionId) : null,
          zenodoDoi: zenodoDoi ? String(zenodoDoi) : null,
          zenodoUrl: zenodoUrl ? String(zenodoUrl) : null,
          environment: environment
        }, { merge: true });
      } catch (err) {
        console.warn('Failed to save paper to Firestore:', err);
      }
    }

    try {
      window.dispatchEvent(new CustomEvent('zenuploader_refresh'));
    } catch (e) {}

    if (onUploadSuccess) {
      onUploadSuccess();
    }
  };

  const cancelProcessing = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsProcessing(false);
  };

  // Unified automatic 1-click processing pipeline
  const processFileDirectly = async (targetFile: File | Blob, forceAi = false) => {
    if (!targetFile) return;

    if ('size' in targetFile && targetFile.size === 0) {
      setError('The selected file is empty (0 bytes) or still downloading from cloud storage. Please verify the file is downloaded completely and select it again.');
      setIsProcessing(false);
      return;
    }

    // Check cache
    if (!forceAi) {
      const cached = getCachedMetadata(targetFile);
      if (cached && (cached.title || cached.abstract)) {
        const applied = applySavedProfile(cached);
        setEditableMetadata(applied);
        setError(null);
        setZenodoReceipt(null);
        setIsProcessing(false);
        try {
          await savePaperToHistory(applied, 'processed');
        } catch (e) {}
        return;
      }
    }

    setIsProcessing(true);
    setError(null);
    setZenodoReceipt(null);

    try {
      const formData = new FormData();
      const safeName = getSafeFileName(targetFile);
      if (targetFile instanceof File) {
        formData.append('pdf', targetFile, safeName);
      } else if (targetFile instanceof Blob) {
        formData.append('pdf', targetFile, safeName);
      } else {
        const fallbackBlob = new Blob([targetFile as any], { type: 'application/pdf' });
        formData.append('pdf', fallbackBlob, 'document.pdf');
      }

      const cleanGeminiKey = (geminiApiKey || '').trim();
      if (cleanGeminiKey) {
        formData.append('geminiApiKey', cleanGeminiKey);
      }
      if (googleUserName) {
        formData.append('userName', googleUserName);
      }

      let data: any = null;
      try {
        const controller = new AbortController();
        abortControllerRef.current = controller;
        const timeoutId = setTimeout(() => controller.abort(), 14000); // 14s responsive timeout

        const response = await fetch('/api/process-pdf', {
          method: 'POST',
          body: formData,
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        const { ok, data: resData, text: resText } = await safeJsonParse(response);
        if (ok && resData && typeof resData === 'object' && resData.title) {
          data = resData;
        } else {
          const errMessage = resData?.error || resData?.message || (resText && resText.length < 200 && !resText.includes('<html') ? resText : 'Server returned an unparseable response');
          console.warn('Server PDF processing note, transitioning to local parser:', errMessage);
        }
      } catch (fetchErr: any) {
        console.warn('Network / timeout note during PDF processing, activating fast parser fallback:', fetchErr);
      } finally {
        abortControllerRef.current = null;
      }

      // Browser fallback parser (instant, never gets stuck)
      if (!data || !data.title) {
        try {
          const arrayBuffer = await targetFile.arrayBuffer();
          data = parseMetadataFromBrowserBuffer(arrayBuffer, safeName);
        } catch (bufErr) {
          data = parseMetadataFromBrowserBuffer(new ArrayBuffer(0), safeName);
        }
      }

      if (googleUserName && data && data.authors && data.authors.length > 0 && (data.authors[0].name === 'Lead Author' || !data.authors[0].name)) {
        data.authors[0].name = googleUserName;
      }

      data = applySavedProfile(data);
      setCachedMetadata(targetFile, data);
      setEditableMetadata(data);
      setError(null);

      try {
        await savePaperToHistory(data, 'processed');
      } catch (histErr) {}
    } catch (error: any) {
      console.error('Error processing PDF:', error);
      // Fallback emergency metadata
      const emergencyData = parseMetadataFromBrowserBuffer(new ArrayBuffer(0), getSafeFileName(targetFile));
      setEditableMetadata(applySavedProfile(emergencyData));
    } finally {
      setIsProcessing(false);
    }
  };

  // Drag & drop handlers
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0];
      const isPdf = droppedFile.type.includes('pdf') || droppedFile.name.toLowerCase().endsWith('.pdf');
      if (isPdf || droppedFile.size > 0) {
        setFile(droppedFile);
        setError(null);
        setZenodoReceipt(null);
        setEditableMetadata(null);
      } else {
        setError('Please drop a valid PDF file (.pdf).');
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      setError(null);
      setZenodoReceipt(null);
      setEditableMetadata(null);
    }
  };

  const handleStartOver = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setFile(null);
    setIsProcessing(false);
    setIsUploadingToZenodo(false);
    setEditableMetadata(null);
    setError(null);
    setZenodoReceipt(null);
    setCopiedDoi(false);
    setCopiedCitation(null);
    try {
      localStorage.removeItem('zenuploader_active_draft');
    } catch (e) {}
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Consolidated generic generator function (eliminates redundant handlers)
  const handleGenerateSection = async (endpoint: string, keyName: string, extraPayload: any = {}) => {
    if (!editableMetadata) return;
    setGeneratingSection(keyName);
    try {
      const cleanGeminiKey = sanitizeHeader(geminiApiKey);
      const res = await fetch(`/api/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editableMetadata.title,
          abstract: editableMetadata.abstract,
          summary: editableMetadata.summary,
          geminiApiKey: cleanGeminiKey,
          ...extraPayload
        })
      });
      const { ok, data } = await safeJsonParse(res);
      if (ok && data) {
        setEditableMetadata((prev: any) => {
          const updated = { ...prev };
          if (data[keyName] !== undefined) {
            updated[keyName] = data[keyName];
          }
          if (keyName === 'longTailKeywords' && data.keywords) {
            updated.longTailKeywords = data.keywords;
          }
          if (keyName === 'keywords' && data.longTailKeywords) {
            updated.longTailKeywords = data.longTailKeywords;
          }
          if (data.seoKeywords) {
            updated.seoKeywords = data.seoKeywords;
          }
          return updated;
        });
      }
    } catch (err) {
      console.error(`Failed to generate ${keyName}:`, err);
    } finally {
      setGeneratingSection(null);
    }
  };

  const handleFetchAuthorWhois = async (authorIdx: number) => {
    const author = editableMetadata?.authors?.[authorIdx];
    if (!author || !author.name) return;
    setLoadingWhoisIndex(authorIdx);
    try {
      const cleanGeminiKey = sanitizeHeader(geminiApiKey);
      const res = await fetch('/api/author-whois', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: author.name,
          affiliation: author.affiliation,
          url: author.url,
          geminiApiKey: cleanGeminiKey
        })
      });
      const { ok, data } = await safeJsonParse(res);
      if (ok && data) {
        const updatedAuthors = [...(editableMetadata.authors || [])];
        updatedAuthors[authorIdx] = {
          ...updatedAuthors[authorIdx],
          whoisBio: data.whoisBio,
          whoisSources: data.sources || []
        };
        setEditableMetadata({ ...editableMetadata, authors: updatedAuthors });
      }
    } catch (err) {
      console.error('Failed to fetch WHOIS bio:', err);
    } finally {
      setLoadingWhoisIndex(null);
    }
  };

  const handleEnrichAll = async () => {
    if (!editableMetadata) return;
    setEnrichingAll(true);
    setEnrichSuccessMsg(false);
    try {
      const cleanGeminiKey = sanitizeHeader(geminiApiKey);
      const res = await fetch('/api/enrich-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metadata: editableMetadata,
          geminiApiKey: cleanGeminiKey
        })
      });
      const { ok, data } = await safeJsonParse(res);
      if (ok && data?.metadata) {
        setEditableMetadata(data.metadata);
        setEnrichSuccessMsg(true);
        setTimeout(() => setEnrichSuccessMsg(false), 5000);
      }
    } catch (err) {
      console.error('Failed to enrich all metadata:', err);
    } finally {
      setEnrichingAll(false);
    }
  };

  // Automatically trigger full-spectrum AI generation on load if sections are incomplete (once per manuscript)
  useEffect(() => {
    if (
      editableMetadata && 
      editableMetadata.title && 
      !enrichingAll && 
      hasAutoEnrichedTitleRef.current !== editableMetadata.title &&
      (!editableMetadata.tldr || !editableMetadata.glossary || editableMetadata.glossary.length === 0)
    ) {
      hasAutoEnrichedTitleRef.current = editableMetadata.title;
      handleEnrichAll();
    }
  }, [editableMetadata?.title]);

  // Step 4: Final upload to Zenodo
  const handleUploadToZenodo = async () => {
    const cleanZenodoKey = (zenodoApiKey || '').trim();
    if (!cleanZenodoKey) {
      const missingKeyMsg = 'Zenodo Personal Access Token is required to deposit directly to Zenodo. Please enter your token in API Settings.';
      setError(missingKeyMsg);
      setAuthErrorInfo({
        is403: false,
        message: missingKeyMsg
      });
      setShowApiSettings(true);
      apiKeysRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const existingDepositionId = editableMetadata?.zenodoRecordId || editableMetadata?.depositionId;
    if (!file && existingDepositionId && !String(existingDepositionId).startsWith('local_') && !String(existingDepositionId).startsWith('paper_')) {
      setIsUploadingToZenodo(true);
      setError(null);
      setAuthErrorInfo(null);
      try {
        const updateRes = await fetch('/api/update-zenodo-paper', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            depositionId: existingDepositionId,
            metadata: editableMetadata,
            zenodoApiKey: cleanZenodoKey,
            zenodoEnv
          })
        });
        const { ok, status, data: updatedData, text: updateText } = await safeJsonParse(updateRes);
        if (!ok) {
          const errMsg = updatedData?.error || updatedData?.message || (updateText && updateText.length < 300 && !updateText.includes('<html') ? updateText : `Failed to update Zenodo deposition (${status})`);
          if (status === 401 || status === 403) {
            setAuthErrorInfo({
              is403: status === 403,
              isIpRestricted: errMsg.includes('IP Restriction') || errMsg.includes('unusual traffic'),
              message: errMsg
            });
          }
          throw new Error(errMsg);
        }
        if (!updatedData) {
          throw new Error('Received unexpected response format when updating deposition.');
        }
        setZenodoReceipt(updatedData);
        try {
          await savePaperToHistory(editableMetadata, 'uploaded', updatedData);
        } catch (saveErr) {}
      } catch (err: any) {
        setError(err?.message || 'Failed to update Zenodo deposition.');
      } finally {
        setIsUploadingToZenodo(false);
      }
      return;
    }

    let targetPdfFile = file;
    if (!targetPdfFile) {
      // If no file in memory (e.g. loaded from Saved Papers history), generate a valid PDF blob from the paper metadata
      const paperTitle = editableMetadata?.title || 'Research Paper';
      const synPdfContent = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>\nendobj\n4 0 obj\n<< /Length 120 >>\nstream\nBT\n/F1 12 Tf\n100 700 Td\n(${paperTitle.replace(/[\r\n()]/g, ' ').slice(0, 100)}) Tj\nET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000216 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n387\n%%EOF`;
      const synBlob = new Blob([synPdfContent], { type: 'application/pdf' });
      const safeSynName = `${(editableMetadata?.title || 'paper').toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 40) || 'paper'}.pdf`;
      targetPdfFile = new File([synBlob], safeSynName, { type: 'application/pdf' });
      setFile(targetPdfFile);
    }

    setIsUploadingToZenodo(true);
    setError(null);
    setAuthErrorInfo(null);
    try {
      const formData = new FormData();
      const safeFileName = getSafeFileName(targetPdfFile);
      if (targetPdfFile instanceof File) {
        formData.append('pdf', targetPdfFile, safeFileName);
      } else if (targetPdfFile instanceof Blob) {
        formData.append('pdf', targetPdfFile, safeFileName);
      } else {
        const fallbackBlob = new Blob([targetPdfFile as any], { type: 'application/pdf' });
        formData.append('pdf', fallbackBlob, safeFileName);
      }
      if (editableMetadata) {
        formData.append('metadata', JSON.stringify(editableMetadata));
      }
      formData.append('zenodoApiKey', cleanZenodoKey);
      formData.append('zenodoEnv', zenodoEnv);
      
      const response = await fetch('/api/upload-to-zenodo', {
        method: 'POST',
        body: formData,
      });

      const { ok, status, data, text } = await safeJsonParse(response);
      if (!ok) {
        let errMessage = data?.error || data?.message;
        if (!errMessage) {
          if (text && text.length < 500 && !text.includes('<html') && !text.includes('<!DOCTYPE')) {
            errMessage = text;
          } else if (status === 413) {
            errMessage = 'The uploaded PDF file is too large for transmission. Please use a compressed or smaller PDF file.';
          } else if (status === 502 || status === 504) {
            errMessage = 'Zenodo upload request timed out. Zenodo servers may be busy. Please try again.';
          } else if (status === 401 || status === 403) {
            errMessage = status === 401 
              ? 'Zenodo authentication failed (401). Invalid token or environment mismatch between Production and Sandbox.'
              : 'Zenodo permission denied (403). Personal Access Token requires "deposit:write" and "deposit:actions" scopes.';
          } else {
            errMessage = `Upload failed with status ${status}. Please verify your token and settings.`;
          }
        }

        const is403 = status === 403 || data?.isPermissionDenied || errMessage.includes('403') || errMessage.includes('Permission Denied');
        const is401 = status === 401 || errMessage.includes('401') || errMessage.toLowerCase().includes('authentication failed');
        const isIpRestricted = data?.isIpRestricted || errMessage.includes('IP Restriction') || errMessage.includes('unusual traffic');
        if (is403 || is401) {
          setAuthErrorInfo({
            is403: is403,
            isIpRestricted: isIpRestricted,
            message: errMessage
          });
        }

        throw new Error(errMessage);
      }

      if (!data || typeof data !== 'object') {
        throw new Error('Received unexpected non-JSON response from upload service. Please try again.');
      }
      
      try {
        await savePaperToHistory(editableMetadata || { title: (file as any)?.name || 'Research Paper' }, 'uploaded', data);
      } catch (saveErr) {}
      
      setZenodoReceipt(data);
    } catch (err: any) {
      console.error('Zenodo upload failed:', err);
      let msg = err?.message || 'Failed to upload to Zenodo';
      if (msg.toLowerCase().includes('load failed') || msg.toLowerCase().includes('failed to fetch')) {
        msg = 'Connection to upload service timed out or was interrupted. Please try again.';
      }
      setError(msg);

      const is403 = msg.includes('403') || msg.includes('Permission Denied');
      const is401 = msg.includes('401') || msg.toLowerCase().includes('authentication failed') || msg.toLowerCase().includes('token is missing') || msg.toLowerCase().includes('token is required');
      const isIpBlocked = msg.includes('IP Restriction') || msg.includes('unusual traffic');
      if (is403 || is401) {
        setAuthErrorInfo({
          is403: is403,
          isIpRestricted: isIpBlocked,
          message: msg
        });
      }

      if (msg.includes('403') || msg.includes('401') || msg.includes('Permission Denied') || msg.toLowerCase().includes('token')) {
        setShowApiSettings(true);
        setTimeout(() => {
          apiKeysRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 150);
      }
    } finally {
      setIsUploadingToZenodo(false);
    }
  };

  // Determine current active step (1: Upload, 2: Process, 3: Review, 4: Publish)
  const currentStep = (zenodoReceipt || isUploadingToZenodo)
    ? 4 
    : isProcessing 
      ? 2 
      : editableMetadata 
        ? 3 
        : 1;

  // Citation helpers
  const authorsText = (editableMetadata?.authors || []).map((a: any) => typeof a === 'string' ? a : a.name).filter(Boolean).join(', ') || 'Authors';
  const yearText = editableMetadata?.publicationDate ? editableMetadata.publicationDate.split('-')[0] : new Date().getFullYear();
  const titleText = editableMetadata?.title || 'Research Paper';
  const doiText = zenodoReceipt?.doi || editableMetadata?.doi || '10.5281/zenodo.xxxxxx';

  const apaCitation = `${authorsText} (${yearText}). ${titleText}. Zenodo. https://doi.org/${doiText}`;
  const bibtexCitation = `@misc{${(authorsText.split(' ')[0] || 'paper').toLowerCase()}${yearText},\n  title={${titleText}},\n  author={${authorsText}},\n  year={${yearText}},\n  publisher={Zenodo},\n  doi={${doiText}}\n}`;

  return (
    <div className="bg-white border border-slate-200/90 rounded-2xl sm:rounded-3xl shadow-xs p-4 sm:p-8 max-w-3xl mx-auto" id="uploader-container">
      
      {/* 4-Step Visual Progress Stepper */}
      <div className="mb-6 pb-5 border-b border-slate-100">
        <div className="grid grid-cols-4 gap-1.5 sm:gap-3">
          
          {/* Step 1: Upload */}
          <div className={`p-2 sm:p-3 rounded-xl sm:rounded-2xl border text-center transition-all flex flex-col items-center justify-center ${
            currentStep === 1 
              ? 'bg-blue-50/90 border-blue-300 text-blue-900 shadow-xs ring-2 ring-blue-100' 
              : currentStep > 1 
                ? 'bg-emerald-50/80 border-emerald-200 text-emerald-800' 
                : 'bg-slate-50 border-slate-200 text-slate-400'
          }`}>
            <div className="flex items-center justify-center gap-1 sm:gap-1.5 font-bold text-[11px] sm:text-xs">
              {currentStep > 1 ? (
                <CheckCircle2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-600 shrink-0" />
              ) : (
                <span className="w-4 h-4 sm:w-5 sm:h-5 rounded-full bg-blue-600 text-white text-[10px] sm:text-xs flex items-center justify-center font-bold shrink-0">1</span>
              )}
              <span>Upload</span>
            </div>
            <p className="text-[10px] text-slate-500 mt-0.5 hidden md:block">Select PDF</p>
          </div>

          {/* Step 2: Process */}
          <div className={`p-2 sm:p-3 rounded-xl sm:rounded-2xl border text-center transition-all flex flex-col items-center justify-center ${
            currentStep === 2 
              ? 'bg-blue-50/90 border-blue-300 text-blue-900 shadow-xs ring-2 ring-blue-100 animate-pulse' 
              : currentStep > 2 
                ? 'bg-emerald-50/80 border-emerald-200 text-emerald-800' 
                : 'bg-slate-50 border-slate-200 text-slate-400'
          }`}>
            <div className="flex items-center justify-center gap-1 sm:gap-1.5 font-bold text-[11px] sm:text-xs">
              {currentStep > 2 ? (
                <CheckCircle2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-600 shrink-0" />
              ) : currentStep === 2 ? (
                <Loader2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-blue-600 animate-spin shrink-0" />
              ) : (
                <span className="w-4 h-4 sm:w-5 sm:h-5 rounded-full bg-slate-300 text-slate-700 text-[10px] sm:text-xs flex items-center justify-center font-bold shrink-0">2</span>
              )}
              <span>Process</span>
            </div>
            <p className="text-[10px] text-slate-500 mt-0.5 hidden md:block">Extract Metadata</p>
          </div>

          {/* Step 3: Review */}
          <div className={`p-2 sm:p-3 rounded-xl sm:rounded-2xl border text-center transition-all flex flex-col items-center justify-center ${
            currentStep === 3 
              ? 'bg-blue-50/90 border-blue-300 text-blue-900 shadow-xs ring-2 ring-blue-100' 
              : currentStep > 3 
                ? 'bg-emerald-50/80 border-emerald-200 text-emerald-800' 
                : 'bg-slate-50 border-slate-200 text-slate-400'
          }`}>
            <div className="flex items-center justify-center gap-1 sm:gap-1.5 font-bold text-[11px] sm:text-xs">
              {currentStep > 3 ? (
                <CheckCircle2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-600 shrink-0" />
              ) : (
                <span className={`w-4 h-4 sm:w-5 sm:h-5 rounded-full ${currentStep === 3 ? 'bg-blue-600 text-white' : 'bg-slate-300 text-slate-700'} text-[10px] sm:text-xs flex items-center justify-center font-bold shrink-0`}>3</span>
              )}
              <span>Review</span>
            </div>
            <p className="text-[10px] text-slate-500 mt-0.5 hidden md:block">Inspect & Edit</p>
          </div>

          {/* Step 4: Publish */}
          <div className={`p-2 sm:p-3 rounded-xl sm:rounded-2xl border text-center transition-all flex flex-col items-center justify-center ${
            currentStep === 4 
              ? 'bg-emerald-50 border-emerald-300 text-emerald-900 shadow-xs ring-2 ring-emerald-100' 
              : 'bg-slate-50 border-slate-200 text-slate-400'
          }`}>
            <div className="flex items-center justify-center gap-1 sm:gap-1.5 font-bold text-[11px] sm:text-xs">
              {zenodoReceipt ? (
                <CheckCircle2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-600 shrink-0" />
              ) : isUploadingToZenodo ? (
                <Loader2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-600 animate-spin shrink-0" />
              ) : (
                <span className="w-4 h-4 sm:w-5 sm:h-5 rounded-full bg-slate-300 text-slate-700 text-[10px] sm:text-xs flex items-center justify-center font-bold shrink-0">4</span>
              )}
              <span>Publish</span>
            </div>
            <p className="text-[10px] text-slate-500 mt-0.5 hidden md:block">Zenodo DOI</p>
          </div>
        </div>
      </div>

      {/* Header & API Settings Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h2 className="text-lg sm:text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-2">
            <span>
              {currentStep === 1 && 'Step 1: Upload Research Paper'}
              {currentStep === 2 && 'Step 2: Extracting Metadata'}
              {currentStep === 3 && 'Step 3: Review & Edit Metadata'}
              {currentStep === 4 && (isUploadingToZenodo ? 'Step 4: Publishing to Zenodo...' : 'Step 4: Published to Zenodo')}
            </span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {currentStep === 1 && 'Drop a PDF manuscript or select a file to begin automated processing.'}
            {currentStep === 2 && 'Gemini AI is parsing and extracting full-spectrum publication metadata.'}
            {currentStep === 3 && 'Verify and customize extracted metadata before depositing to Zenodo.'}
            {currentStep === 4 && 'Your manuscript is deposited and permanently registered on Zenodo with DOI.'}
          </p>
        </div>
        
        <div className="flex items-center gap-2 shrink-0 self-start sm:self-center">
          <button
            type="button"
            onClick={() => setShowApiSettings(!showApiSettings)}
            className={`px-3 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
              showApiSettings 
                ? 'bg-slate-800 text-white border-slate-800' 
                : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
            }`}
            title="Configure Zenodo & Gemini API Keys"
          >
            <Key className="w-3.5 h-3.5" />
            <span>API Settings</span>
            <span className={`w-2 h-2 rounded-full ${zenodoApiKey ? 'bg-emerald-500' : 'bg-amber-400'}`} />
          </button>
        </div>
      </div>

      {/* Collapsible API Keys Settings Drawer */}
      <AnimatePresence>
        {showApiSettings && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-6 overflow-hidden"
          >
            <div ref={apiKeysRef} className="p-5 bg-slate-50 rounded-2xl border border-slate-200 space-y-4 shadow-xs">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
                  <Key className="w-3.5 h-3.5 text-indigo-600" /> API Credentials & Environment Settings
                </h3>
                <span className="text-[11px] text-slate-500">Stored safely in browser / Firestore</span>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">
                      Zenodo Personal Access Token
                    </label>
                    <input
                      type="password"
                      value={zenodoApiKey}
                      onChange={(e) => {
                        setZenodoApiKey(e.target.value);
                        setVerifyStatus(null);
                      }}
                      className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs font-mono focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                      placeholder="Zenodo Personal Access Token"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold text-slate-600 mb-1">Target Environment</label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => setZenodoEnv('auto')}
                        className={`px-2 py-1.5 rounded-lg border font-medium cursor-pointer transition-all ${
                          zenodoEnv === 'auto'
                            ? 'bg-indigo-600 text-white border-indigo-600 font-bold shadow-xs'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        Auto-Detect
                      </button>
                      <button
                        type="button"
                        onClick={() => setZenodoEnv('production')}
                        className={`px-2.5 py-1.5 rounded-lg border font-medium cursor-pointer transition-all ${
                          zenodoEnv === 'production'
                            ? 'bg-indigo-600 text-white border-indigo-600 font-bold shadow-xs'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        Production
                      </button>
                      <button
                        type="button"
                        onClick={() => setZenodoEnv('sandbox')}
                        className={`px-2.5 py-1.5 rounded-lg border font-medium cursor-pointer transition-all ${
                          zenodoEnv === 'sandbox'
                            ? 'bg-indigo-600 text-white border-indigo-600 font-bold shadow-xs'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        Sandbox
                      </button>
                    </div>
                  </div>

                  <div className="p-2.5 bg-blue-50/70 border border-blue-100 rounded-xl text-[10px] text-blue-900 space-y-1">
                    <p className="font-semibold flex items-center gap-1">
                      <ShieldCheck className="w-3 h-3 text-blue-600 shrink-0" /> Required Token Permissions:
                    </p>
                    <p className="text-slate-600">
                      When creating your token, you must check <code className="bg-white px-1 py-0.5 rounded border border-blue-200 font-mono text-[9px] font-bold text-blue-700">deposit:write</code> and <code className="bg-white px-1 py-0.5 rounded border border-blue-200 font-mono text-[9px] font-bold text-blue-700">deposit:actions</code>.
                    </p>
                    <div className="flex items-center gap-3 pt-0.5">
                      <a 
                        href="https://zenodo.org/account/settings/applications/tokens/new/" 
                        target="_blank" 
                        rel="noreferrer"
                        className="text-indigo-600 hover:text-indigo-800 underline font-bold inline-flex items-center gap-0.5"
                      >
                        Zenodo Production Token <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                      <a 
                        href="https://sandbox.zenodo.org/account/settings/applications/tokens/new/" 
                        target="_blank" 
                        rel="noreferrer"
                        className="text-indigo-600 hover:text-indigo-800 underline font-bold inline-flex items-center gap-0.5"
                      >
                        Sandbox Token <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">Gemini API Key (Optional)</label>
                    <input
                      type="password"
                      value={geminiApiKey}
                      onChange={(e) => setGeminiApiKey(e.target.value)}
                      className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs font-mono focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                      placeholder="Custom Gemini API Key (Optional)"
                    />
                    <p className="text-[10px] text-slate-400 mt-1">Uses server default if left blank.</p>
                  </div>

                  {verifyStatus && (
                    <div className={`p-3 rounded-xl border text-xs ${
                      verifyStatus.success 
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800' 
                        : 'bg-amber-50 border-amber-200 text-amber-900'
                    }`}>
                      <div className="flex items-start gap-2">
                        {verifyStatus.success ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                        ) : (
                          <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                        )}
                        <div>
                          <p className="font-semibold">{verifyStatus.success ? 'Token Verified' : 'Token Check Notice'}</p>
                          <p className="text-[11px] mt-0.5">{verifyStatus.message || verifyStatus.error}</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={handleVerifyZenodoToken}
                  disabled={verifyingKey || !zenodoApiKey.trim()}
                  className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold text-xs transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
                >
                  {verifyingKey ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600" /> Verifying with Zenodo...</>
                  ) : (
                    <><ShieldCheck className="w-3.5 h-3.5 text-indigo-600" /> Test Token & Scopes</>
                  )}
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={saveApiKeys}
                    disabled={savingKey}
                    className="px-4 py-1.5 bg-indigo-600 text-white rounded-xl font-bold text-xs hover:bg-indigo-700 transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shadow-xs"
                  >
                    {savingKey ? (
                      <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving...</>
                    ) : keysSaved ? (
                      <><CheckCircle2 className="w-3.5 h-3.5" /> Saved!</>
                    ) : (
                      'Save Settings'
                    )}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!user && (
        <div className="mb-6 p-3.5 bg-indigo-50/80 border border-indigo-200 rounded-xl flex items-center justify-between gap-3 text-xs text-indigo-900">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-indigo-600 shrink-0" />
            <span><strong>Guest Mode:</strong> Uploads work automatically. Sign in with Google to sync publication history across devices.</span>
          </div>
          <button
            type="button"
            onClick={handleLogin}
            disabled={signingIn}
            className="px-3 py-1.5 bg-indigo-600 text-white font-bold rounded-lg hover:bg-indigo-700 transition-all text-xs shrink-0 cursor-pointer"
          >
            {signingIn ? 'Signing in...' : 'Sign in'}
          </button>
        </div>
      )}

      {/* Error banner with Quick Fix Actions */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 rounded-xl border border-red-200 text-red-700 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start sm:items-center gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5 sm:mt-0" />
              <div className="text-sm font-medium leading-relaxed">{error}</div>
            </div>
            <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
              <button
                type="button"
                onClick={handleStartOver}
                className="px-2.5 py-1 text-xs font-bold text-red-700 bg-red-100 hover:bg-red-200 rounded-lg shrink-0 cursor-pointer"
              >
                Start Fresh
              </button>
              <button
                type="button"
                onClick={() => setError(null)}
                className="text-xs font-bold text-red-600 hover:text-red-800 underline shrink-0 cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          </div>

          {(error.includes('403') || error.includes('Permission Denied') || error.toLowerCase().includes('zenodo') || error.includes('401') || error.toLowerCase().includes('token') || authErrorInfo) && (
            <div className="pt-2.5 border-t border-red-200/80 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="text-red-800 font-medium">
                <span>💡 Fix: Ensure your token has <strong>deposit:write</strong> and <strong>deposit:actions</strong> enabled, or switch between <strong>Production</strong> and <strong>Sandbox</strong>.</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setZenodoEnv('sandbox');
                    setShowApiSettings(true);
                    setTimeout(() => apiKeysRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
                  }}
                  className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg text-xs transition-all flex items-center gap-1 cursor-pointer shadow-xs"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Use Sandbox</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowApiSettings(true);
                    setTimeout(() => apiKeysRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
                  }}
                  className="px-3 py-1.5 bg-white border border-red-300 hover:bg-red-50 text-red-700 font-bold rounded-lg text-xs transition-all flex items-center gap-1 cursor-pointer shadow-2xs"
                >
                  <Key className="w-3.5 h-3.5 text-red-600" />
                  <span>Configure Token</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* STEP 1: Upload Dropzone & Process Trigger (Rendered ONLY on Step 1) */}
      {currentStep === 1 && (
        <div className="space-y-4">
          {!file ? (
            <div
              role="button"
              tabIndex={0}
              id="pdf-dropzone"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-2xl p-8 sm:p-12 flex flex-col items-center justify-center cursor-pointer transition-all ${
                isDragging ? 'border-blue-500 bg-blue-50/80 ring-4 ring-blue-100' : 'border-slate-300 hover:border-blue-500 hover:bg-blue-50/40 bg-slate-50/30'
              }`}
            >
              <div className="w-14 h-14 rounded-2xl bg-blue-100 text-blue-600 flex items-center justify-center mb-3.5 shadow-2xs">
                <Upload className="w-7 h-7" />
              </div>
              <h3 className="text-base font-bold text-slate-900 text-center">
                Drop your research PDF here or click to browse
              </h3>
              <span className="text-xs text-slate-500 mt-1 text-center">
                Select your manuscript PDF, then click &ldquo;Process&rdquo; to extract metadata and prepare for Zenodo
              </span>
              
              <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  id="select-pdf-button"
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl shadow-xs transition-all flex items-center gap-2 cursor-pointer"
                >
                  <FolderOpen className="w-4 h-4" />
                  <span>Select PDF Document</span>
                </button>
              </div>
            </div>
          ) : (
            <div 
              className="p-6 sm:p-8 bg-slate-50/80 border-2 border-blue-200 rounded-2xl space-y-6 shadow-xs"
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 bg-white rounded-xl border border-slate-200 shadow-2xs">
                <div className="flex items-center gap-3.5 min-w-0">
                  <div className="w-12 h-12 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center shrink-0 shadow-2xs">
                    <FileText className="w-6 h-6" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-slate-900 truncate block">
                        {file.name}
                      </span>
                      <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 border border-emerald-200 text-[10px] font-bold rounded-md shrink-0">
                        Selected
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {file.size > 0 
                        ? (file.size < 1048576 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / 1048576).toFixed(2)} MB`)
                        : 'PDF Document'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    id="change-pdf-button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer"
                    title="Choose a different PDF file"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-slate-600" />
                    <span>Change File</span>
                  </button>

                  <button
                    type="button"
                    id="remove-pdf-button"
                    onClick={() => {
                      setFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                    className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all cursor-pointer"
                    title="Remove selected file"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Action Bar with Process Button */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
                <p className="text-xs text-slate-600">
                  Ready to analyze manuscript and generate structured metadata.
                </p>

                <button
                  type="button"
                  id="process-pdf-btn"
                  onClick={() => processFileDirectly(file)}
                  className="w-full sm:w-auto px-6 py-3 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-bold rounded-xl shadow-sm hover:shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>Process PDF</span>
                </button>
              </div>
            </div>
          )}

          <input
            ref={fileInputRef}
            id="pdf-file-picker"
            type="file"
            onChange={handleFileChange}
            onClick={(e) => {
              (e.target as HTMLInputElement).value = '';
            }}
            className="sr-only"
            accept=".pdf,application/pdf"
          />
        </div>
      )}

      {/* STEP 2: Active Auto-Processing (Rendered ONLY on Step 2) */}
      {currentStep === 2 && (
        <div className="p-8 bg-gradient-to-b from-blue-50/70 to-indigo-50/40 border-2 border-blue-200 rounded-2xl text-center space-y-4 shadow-xs">
          <div className="w-14 h-14 rounded-2xl bg-blue-600 text-white flex items-center justify-center mx-auto shadow-md">
            <Loader2 className="w-7 h-7 animate-spin" />
          </div>
          <div className="space-y-1">
            <h3 className="text-base font-bold text-slate-900">Step 2: Auto-Processing Metadata...</h3>
            <p className="text-xs text-slate-600 max-w-md mx-auto">
              Extracting title, authors, abstract, TL;DR, key takeaways, novelties, benchmarks, 15+ glossary terms, and FAQs in a single pass.
            </p>
          </div>

          <div className="max-w-sm mx-auto p-3.5 bg-white/90 rounded-xl border border-blue-100 text-left space-y-2 text-[11px] text-slate-700 shadow-2xs">
            <div className="flex items-center gap-2 text-blue-700 font-semibold">
              <Sparkles className="w-3.5 h-3.5 animate-spin" />
              <span>AI Processing active ({file?.name || 'document.pdf'})</span>
            </div>
            <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
              <div className="bg-blue-600 h-full w-3/4 animate-pulse rounded-full" />
            </div>
          </div>

          <div className="pt-2">
            <button
              type="button"
              onClick={cancelProcessing}
              className="text-xs text-slate-500 hover:text-slate-800 underline cursor-pointer"
            >
              Cancel or skip waiting
            </button>
          </div>
        </div>
      )}

      {/* STEP 4: Publication Progress or Success Receipt (Rendered ONLY on Step 4) */}
      {currentStep === 4 && (
        <div className="space-y-6">
          {isUploadingToZenodo ? (
            <div className="p-8 bg-gradient-to-b from-emerald-50/70 to-teal-50/40 border-2 border-emerald-200 rounded-2xl text-center space-y-4 shadow-xs">
              <div className="w-14 h-14 rounded-2xl bg-emerald-600 text-white flex items-center justify-center mx-auto shadow-md">
                <Loader2 className="w-7 h-7 animate-spin" />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-bold text-slate-900">Step 4: Depositing Paper to Zenodo...</h3>
                <p className="text-xs text-slate-600 max-w-md mx-auto">
                  Uploading manuscript PDF, creating deposition, registering metadata, and minting permanent DOI on Zenodo.
                </p>
              </div>

              <div className="max-w-sm mx-auto p-3.5 bg-white/90 rounded-xl border border-emerald-100 text-left space-y-2 text-[11px] text-slate-700 shadow-2xs">
                <div className="flex items-center gap-2 text-emerald-700 font-semibold">
                  <CloudUpload className="w-3.5 h-3.5 animate-bounce" />
                  <span>Submitting {file?.name || editableMetadata?.title || 'document.pdf'}</span>
                </div>
                <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                  <div className="bg-emerald-600 h-full w-4/5 animate-pulse rounded-full" />
                </div>
              </div>
            </div>
          ) : zenodoReceipt ? (
            <div className="p-6 bg-emerald-50/80 rounded-2xl border border-emerald-200 space-y-5">
              <div className="flex items-center gap-3 text-emerald-900">
                <div className="p-2.5 bg-emerald-600 text-white rounded-xl shadow-xs">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-emerald-950 flex items-center gap-2 flex-wrap">
                    <span>Step 4 Complete: Upload Successful!</span>
                  </h3>
                  <p className="text-xs text-emerald-800">
                    Your research paper has been deposited to Zenodo and assigned a permanent DOI.
                  </p>
                </div>
              </div>

              {zenodoReceipt.doi && (
                <div className="p-3.5 bg-white border border-emerald-200 rounded-xl flex items-center justify-between gap-2 shadow-2xs">
                  <div className="min-w-0">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Persistent Identifier (DOI)</span>
                    <span className="text-xs sm:text-sm font-mono font-bold text-slate-800 truncate block">{zenodoReceipt.doi}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(zenodoReceipt.doi);
                      setCopiedDoi(true);
                      setTimeout(() => setCopiedDoi(false), 2500);
                    }}
                    className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold flex items-center gap-1 cursor-pointer shrink-0"
                  >
                    {copiedDoi ? <><Check className="w-3.5 h-3.5 text-emerald-600" /> Copied!</> : <><Copy className="w-3.5 h-3.5" /> Copy DOI</>}
                  </button>
                </div>
              )}

              {/* Quick Citation Snippets */}
              <div className="space-y-2 pt-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-950">Citations & References</span>
                </div>
                <div className="p-3 bg-white/90 border border-emerald-200/80 rounded-xl space-y-2 text-xs text-slate-700">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-800">APA Citation:</span>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(apaCitation);
                        setCopiedCitation('apa');
                        setTimeout(() => setCopiedCitation(null), 2500);
                      }}
                      className="text-[11px] font-semibold text-indigo-600 hover:underline flex items-center gap-1 cursor-pointer"
                    >
                      {copiedCitation === 'apa' ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedCitation === 'apa' ? 'Copied' : 'Copy APA'}</span>
                    </button>
                  </div>
                  <p className="text-[11px] font-serif text-slate-600 bg-slate-50 p-2 rounded-lg border border-slate-100">{apaCitation}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                <a 
                  href={zenodoReceipt.links?.html || (zenodoReceipt.doi ? `https://doi.org/${zenodoReceipt.doi}` : '#')} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="px-4 py-2.5 bg-emerald-600 text-white rounded-xl font-bold text-xs hover:bg-emerald-700 text-center flex items-center justify-center gap-1.5 shadow-xs cursor-pointer"
                >
                  <span>View Record on Zenodo</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </a>
                <button
                  type="button"
                  onClick={handleStartOver}
                  className="px-4 py-2.5 bg-white text-emerald-800 border border-emerald-200 rounded-xl font-bold text-xs hover:bg-emerald-100 text-center cursor-pointer shadow-2xs"
                >
                  Upload Another Paper
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* STEP 3: Review & Edit Metadata Screen (Rendered ONLY on Step 3) */}
      {currentStep === 3 && editableMetadata && (
        <div className="space-y-6">
          
          {/* Top Document Summary & Action Bar */}
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-start sm:items-center gap-3 min-w-0">
              <div className="p-2.5 bg-blue-600 text-white rounded-xl shrink-0 flex items-center justify-center shadow-xs">
                <FileText className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <p className="font-bold text-slate-900 truncate max-w-md sm:max-w-xs md:max-w-md">
                  {file?.name || editableMetadata?.title || 'Loaded Research Document'}
                </p>
                <p className="text-[11px] text-slate-500">
                  {file ? `${(file.size / (1024 * 1024)).toFixed(2)} MB • Ready for Zenodo Submission` : 'Metadata loaded for review'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
              <button
                type="button"
                onClick={handleStartOver}
                className="px-3 py-1.5 bg-white hover:bg-rose-50 border border-slate-200 hover:border-rose-200 text-rose-700 font-semibold rounded-xl transition-all flex items-center gap-1 text-xs cursor-pointer shadow-2xs"
                title="Clear current document and start fresh"
              >
                <X className="w-3.5 h-3.5" />
                <span>Change PDF</span>
              </button>
              {file && (
                <button
                  type="button"
                  onClick={() => processFileDirectly(file, true)}
                  disabled={isProcessing}
                  className="px-3 py-1.5 bg-white hover:bg-blue-50 border border-slate-200 hover:border-blue-200 text-blue-700 font-semibold rounded-xl transition-all flex items-center gap-1 text-xs cursor-pointer shadow-2xs"
                  title="Reprocess fresh"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reprocess</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleUploadToZenodo}
                disabled={isUploadingToZenodo}
                className="px-4 py-1.5 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition-all flex items-center gap-1.5 text-xs shadow-xs cursor-pointer disabled:opacity-50"
              >
                {isUploadingToZenodo ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudUpload className="w-3.5 h-3.5" />}
                <span>Upload to Zenodo</span>
              </button>
            </div>
          </div>

          {/* Master Bulk Generation Action Banner */}
          <div className="p-4 bg-gradient-to-r from-indigo-50 via-purple-50 to-blue-50 rounded-2xl border border-indigo-200/80 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-indigo-600" />
                <h4 className="text-sm font-bold text-slate-900">1-Click Full-Spectrum AI Re-Generation</h4>
                <span className="px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider bg-indigo-600 text-white rounded-full">All Sections</span>
              </div>
              <p className="text-xs text-slate-600">
                Re-synchronizes TL;DR, Takeaways, Benchmarks, Limitations, Novelties, 15+ Glossary Terms, 20 FAQs, Keywords, Applications, and WHOIS Bios simultaneously.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {enrichSuccessMsg && (
                <span className="text-xs font-bold text-emerald-700 bg-emerald-100 px-3 py-1.5 rounded-lg flex items-center gap-1 animate-pulse">
                  <Check className="w-3.5 h-3.5" /> All Generated!
                </span>
              )}
              <button
                type="button"
                onClick={handleEnrichAll}
                disabled={enrichingAll}
                className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition-all shadow-sm flex items-center gap-2 disabled:opacity-50 cursor-pointer"
              >
                {enrichingAll ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Generating All Sections...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 text-amber-300" />
                    <span>⚡ Regenerate All</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Active Loading Indicator Banner when auto-enriching */}
          {enrichingAll && (
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-2xl flex items-center gap-3 text-xs text-blue-900 animate-pulse shadow-xs">
              <Loader2 className="w-5 h-5 text-blue-600 animate-spin shrink-0" />
              <div>
                <p className="font-bold">Auto-generating paper insights, glossary, FAQs, and metadata...</p>
                <p className="text-[11px] text-blue-700">All sections are being populated automatically on this page.</p>
              </div>
            </div>
          )}

          {/* Section 1: General & Authors */}
          <div className="p-5 bg-white rounded-2xl border border-slate-200 space-y-6">
              
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-900 mb-1.5">Paper Title</label>
                  <input 
                    value={editableMetadata.title || ''} 
                    onChange={(e) => setEditableMetadata({...editableMetadata, title: e.target.value})}
                    className="w-full px-3.5 py-2.5 text-xs sm:text-sm bg-slate-50/50 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none font-semibold text-slate-900"
                    placeholder="Primary title of the research paper"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-900 mb-1.5">Alternative / Translated Title</label>
                    <input 
                      value={editableMetadata.alternativeTitle || ''} 
                      onChange={(e) => setEditableMetadata({...editableMetadata, alternativeTitle: e.target.value})}
                      className="w-full px-3 py-2 text-xs bg-slate-50/50 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                      placeholder="Optional secondary title"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-900 mb-1.5">Journal / Conference Name</label>
                    <input 
                      value={editableMetadata.journalName || ''} 
                      onChange={(e) => setEditableMetadata({...editableMetadata, journalName: e.target.value})}
                      className="w-full px-3 py-2 text-xs bg-slate-50/50 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                      placeholder="e.g. NeurIPS, IEEE Trans, Nature"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-900 mb-1.5">Publication Date</label>
                    <input 
                      value={editableMetadata.publicationDate || ''} 
                      onChange={(e) => setEditableMetadata({...editableMetadata, publicationDate: e.target.value})}
                      className="w-full px-3 py-2 text-xs bg-slate-50/50 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none font-mono"
                      placeholder="YYYY-MM-DD"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-900 mb-1.5">License</label>
                    <input 
                      value={editableMetadata.license || 'cc-by-4.0'} 
                      onChange={(e) => setEditableMetadata({...editableMetadata, license: e.target.value})}
                      className="w-full px-3 py-2 text-xs bg-slate-50/50 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none font-mono"
                      placeholder="e.g. cc-by-4.0"
                    />
                  </div>
                </div>
              </div>

              {/* Authors Section */}
              <div className="pt-4 border-t border-slate-200">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h4 className="text-xs font-bold text-slate-900 flex items-center gap-1.5 uppercase tracking-wider">
                      <UserCheck className="w-3.5 h-3.5 text-blue-600" /> Authors & WHOIS Biographies
                    </h4>
                  </div>
                  <div className="flex items-center gap-2">
                    {googleUserName && (
                      <button
                        type="button"
                        onClick={() => {
                          const current = editableMetadata.authors || [];
                          if (current.length > 0) {
                            const updated = [...current];
                            updated[0] = { ...updated[0], name: googleUserName };
                            setEditableMetadata({ ...editableMetadata, authors: updated });
                          } else {
                            setEditableMetadata({
                              ...editableMetadata,
                              authors: [{ name: googleUserName, affiliation: '', url: '', whoisBio: '' }]
                            });
                          }
                        }}
                        className="px-2.5 py-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
                      >
                        <Sparkles className="w-3 h-3 text-emerald-600" /> Use Google Name ({googleUserName})
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        const current = editableMetadata.authors || [];
                        setEditableMetadata({
                          ...editableMetadata,
                          authors: [...current, { name: '', affiliation: '', url: '', whoisBio: '' }]
                        });
                      }}
                      className="px-2.5 py-1 text-[11px] font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
                    >
                      <Plus className="w-3 h-3" /> Add Author
                    </button>
                  </div>
                </div>

                <div className="space-y-3">
                  {(editableMetadata.authors || []).map((author: any, idx: number) => (
                    <div key={idx} className="p-3.5 bg-slate-50/70 border border-slate-200 rounded-xl space-y-2.5 relative">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-700">Author #{idx + 1}</span>
                        <div className="flex items-center gap-1.5">
                          {idx === 0 && (
                            <button
                              type="button"
                              onClick={() => persistPermanentAuthorProfile(author)}
                              disabled={savingAuthorProfile || !author.name}
                              className="px-2 py-0.5 text-[10px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-md transition-colors flex items-center gap-1 disabled:opacity-50 cursor-pointer"
                            >
                              {authorProfileSavedMsg ? 'Saved Profile!' : 'Save Profile Default'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleFetchAuthorWhois(idx)}
                            disabled={loadingWhoisIndex === idx || !author.name}
                            className="px-2 py-0.5 text-[10px] font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-md transition-colors flex items-center gap-1 disabled:opacity-50 cursor-pointer"
                          >
                            {loadingWhoisIndex === idx ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                            <span>WHOIS Bio</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const authors = [...(editableMetadata.authors || [])];
                              authors.splice(idx, 1);
                              setEditableMetadata({ ...editableMetadata, authors });
                            }}
                            className="text-slate-400 hover:text-red-500 p-1 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <input
                          value={author.name || ''}
                          onChange={(e) => {
                            const authors = [...(editableMetadata.authors || [])];
                            authors[idx] = { ...authors[idx], name: e.target.value };
                            setEditableMetadata({ ...editableMetadata, authors });
                          }}
                          className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg font-medium"
                          placeholder="Author Name"
                        />
                        <input
                          value={author.affiliation || ''}
                          onChange={(e) => {
                            const authors = [...(editableMetadata.authors || [])];
                            authors[idx] = { ...authors[idx], affiliation: e.target.value };
                            setEditableMetadata({ ...editableMetadata, authors });
                          }}
                          className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                          placeholder="Affiliation / Institute"
                        />
                        <input
                          value={author.url || ''}
                          onChange={(e) => {
                            const authors = [...(editableMetadata.authors || [])];
                            authors[idx] = { ...authors[idx], url: e.target.value };
                            setEditableMetadata({ ...editableMetadata, authors });
                          }}
                          className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                          placeholder="Website / ORCID"
                        />
                      </div>

                      <textarea
                        rows={2}
                        value={author.whoisBio || ''}
                        onChange={(e) => {
                          const authors = [...(editableMetadata.authors || [])];
                          authors[idx] = { ...authors[idx], whoisBio: e.target.value };
                          setEditableMetadata({ ...editableMetadata, authors });
                        }}
                        className="w-full text-xs p-2 bg-white border border-slate-200 rounded-lg text-slate-800 leading-relaxed"
                        placeholder="Author professional biography..."
                      />
                    </div>
                  ))}
                </div>
              </div>

            </div>

          {/* Section 2: TL;DR & Abstract */}
          <div className="p-5 bg-white rounded-2xl border border-slate-200 space-y-6">
              
              {/* TL;DR */}
              <div className="bg-emerald-50/70 border border-emerald-200 rounded-2xl p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="p-1 bg-emerald-600 text-white rounded font-mono font-bold text-[10px]">TL;DR</span>
                    <span className="text-xs font-bold text-slate-900">Core Punchline</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleGenerateSection('generate-tldr', 'tldr')}
                    disabled={generatingSection === 'tldr'}
                    className="px-2.5 py-1 text-[11px] font-semibold text-emerald-800 bg-white border border-emerald-300 hover:bg-emerald-50 rounded-lg transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    {generatingSection === 'tldr' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-emerald-600" />}
                    <span>Regenerate TL;DR</span>
                  </button>
                </div>
                <textarea
                  rows={2}
                  value={editableMetadata.tldr || ''}
                  onChange={(e) => setEditableMetadata({ ...editableMetadata, tldr: e.target.value })}
                  className="w-full px-3 py-2 text-xs bg-white border border-emerald-200 rounded-xl focus:ring-2 focus:ring-emerald-500 font-medium text-slate-900 leading-relaxed"
                  placeholder="1-2 sentence core finding..."
                />
              </div>

              {/* Key Takeaways */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900 uppercase tracking-wider">Key Executive Takeaways</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleGenerateSection('generate-takeaways', 'keyTakeaways')}
                      disabled={generatingSection === 'keyTakeaways'}
                      className="px-2.5 py-1 text-[11px] font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100 rounded-lg transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      {generatingSection === 'keyTakeaways' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-amber-600" />}
                      <span>Auto-Generate</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const current = Array.isArray(editableMetadata.keyTakeaways) ? editableMetadata.keyTakeaways : [];
                        setEditableMetadata({ ...editableMetadata, keyTakeaways: [...current, ''] });
                      }}
                      className="px-2 py-1 text-[11px] font-semibold text-blue-600 bg-blue-50 rounded-lg cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  {(Array.isArray(editableMetadata.keyTakeaways) ? editableMetadata.keyTakeaways : []).map((item: string, tIdx: number) => (
                    <div key={tIdx} className="flex items-center gap-2 bg-amber-50/40 p-1.5 border border-amber-100 rounded-xl">
                      <span className="text-xs font-bold text-amber-600 ml-1">●</span>
                      <input
                        value={item || ''}
                        onChange={(e) => {
                          const keyTakeaways = [...(Array.isArray(editableMetadata.keyTakeaways) ? editableMetadata.keyTakeaways : [])];
                          keyTakeaways[tIdx] = e.target.value;
                          setEditableMetadata({ ...editableMetadata, keyTakeaways });
                        }}
                        className="w-full text-xs p-1.5 bg-white border border-slate-200 rounded-lg text-slate-800"
                        placeholder="Key takeaway..."
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const keyTakeaways = [...(Array.isArray(editableMetadata.keyTakeaways) ? editableMetadata.keyTakeaways : [])];
                          keyTakeaways.splice(tIdx, 1);
                          setEditableMetadata({ ...editableMetadata, keyTakeaways });
                        }}
                        className="text-slate-400 hover:text-red-500 p-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Abstract */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-bold text-slate-900">Abstract</label>
                  <button
                    type="button"
                    onClick={() => handleGenerateSection('generate-abstract', 'abstract')}
                    disabled={generatingSection === 'abstract'}
                    className="px-2.5 py-1 text-[11px] font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    {generatingSection === 'abstract' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-blue-600" />}
                    <span>Auto-Generate / Refine</span>
                  </button>
                </div>
                <textarea 
                  value={editableMetadata.abstract || ''} 
                  onChange={(e) => setEditableMetadata({...editableMetadata, abstract: e.target.value})}
                  className="w-full px-3.5 py-2.5 text-xs sm:text-sm bg-slate-50/50 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none leading-relaxed"
                  rows={5}
                  placeholder="Original paper abstract..."
                />
              </div>

              {/* Detailed Summary */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-bold text-slate-900">Comprehensive Summary</label>
                  <button
                    type="button"
                    onClick={() => handleGenerateSection('generate-summary', 'summary')}
                    disabled={generatingSection === 'summary'}
                    className="px-2.5 py-1 text-[11px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    {generatingSection === 'summary' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-indigo-600" />}
                    <span>Auto-Generate Summary</span>
                  </button>
                </div>
                <textarea 
                  value={editableMetadata.summary || ''} 
                  onChange={(e) => setEditableMetadata({...editableMetadata, summary: e.target.value})}
                  className="w-full px-3.5 py-2.5 text-xs sm:text-sm bg-slate-50/50 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none leading-relaxed"
                  rows={4}
                  placeholder="Detailed summary of contributions and findings..."
                />
              </div>

            </div>

          {/* Section 3: Novelties & Benchmarks */}
          <div className="p-5 bg-white rounded-2xl border border-slate-200 space-y-6">
              
              {/* Novelties */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900 uppercase tracking-wider">Paper Novelties & Breakthroughs</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleGenerateSection('generate-novelties', 'novelties')}
                      disabled={generatingSection === 'novelties'}
                      className="px-2.5 py-1 text-[11px] font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      {generatingSection === 'novelties' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-emerald-600" />}
                      <span>Auto-Generate</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const current = Array.isArray(editableMetadata.novelties) ? editableMetadata.novelties : [];
                        setEditableMetadata({ ...editableMetadata, novelties: [...current, ''] });
                      }}
                      className="px-2 py-1 text-[11px] font-semibold text-blue-600 bg-blue-50 rounded-lg cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  {(Array.isArray(editableMetadata.novelties) ? editableMetadata.novelties : []).map((novItem: string, nIdx: number) => (
                    <div key={nIdx} className="flex items-start gap-2 bg-emerald-50/40 p-2 border border-emerald-100 rounded-xl">
                      <span className="text-xs font-bold text-emerald-600 mt-1">#{nIdx + 1}</span>
                      <textarea
                        rows={2}
                        value={novItem || ''}
                        onChange={(e) => {
                          const novelties = [...(Array.isArray(editableMetadata.novelties) ? editableMetadata.novelties : [])];
                          novelties[nIdx] = e.target.value;
                          setEditableMetadata({ ...editableMetadata, novelties });
                        }}
                        className="w-full text-xs p-1.5 bg-white border border-slate-200 rounded-lg text-slate-800 leading-relaxed"
                        placeholder="Specific contribution or breakthrough..."
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const novelties = [...(Array.isArray(editableMetadata.novelties) ? editableMetadata.novelties : [])];
                          novelties.splice(nIdx, 1);
                          setEditableMetadata({ ...editableMetadata, novelties });
                        }}
                        className="text-slate-400 hover:text-red-500 p-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Benchmarks */}
              <div className="space-y-2 pt-4 border-t border-slate-200">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900 uppercase tracking-wider">Datasets & Quantitative Benchmarks</span>
                  <button
                    type="button"
                    onClick={() => handleGenerateSection('generate-benchmarks', 'datasetsAndBenchmarks')}
                    disabled={generatingSection === 'datasetsAndBenchmarks'}
                    className="px-2.5 py-1 text-[11px] font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    {generatingSection === 'datasetsAndBenchmarks' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-blue-600" />}
                    <span>Auto-Extract Benchmarks</span>
                  </button>
                </div>

                <div className="space-y-1.5">
                  {(Array.isArray(editableMetadata.datasetsAndBenchmarks) ? editableMetadata.datasetsAndBenchmarks : []).map((item: any, bIdx: number) => (
                    <div key={bIdx} className="flex items-center gap-2 bg-blue-50/40 p-1.5 border border-blue-100 rounded-xl">
                      <input
                        value={typeof item === 'string' ? item : (item.result || item.dataset || '')}
                        onChange={(e) => {
                          const list = [...(Array.isArray(editableMetadata.datasetsAndBenchmarks) ? editableMetadata.datasetsAndBenchmarks : [])];
                          list[bIdx] = e.target.value;
                          setEditableMetadata({ ...editableMetadata, datasetsAndBenchmarks: list });
                        }}
                        className="w-full text-xs p-1.5 bg-white border border-slate-200 rounded-lg font-mono text-slate-800"
                        placeholder="e.g. Accuracy / Speedup Benchmark"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const list = [...(Array.isArray(editableMetadata.datasetsAndBenchmarks) ? editableMetadata.datasetsAndBenchmarks : [])];
                          list.splice(bIdx, 1);
                          setEditableMetadata({ ...editableMetadata, datasetsAndBenchmarks: list });
                        }}
                        className="text-slate-400 hover:text-red-500 p-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Limitations */}
              <div className="space-y-2 pt-4 border-t border-slate-200">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900 uppercase tracking-wider">Limitations & Open Directions</span>
                  <button
                    type="button"
                    onClick={() => handleGenerateSection('generate-limitations', 'limitationsAndFutureWork')}
                    disabled={generatingSection === 'limitationsAndFutureWork'}
                    className="px-2.5 py-1 text-[11px] font-semibold text-orange-700 bg-orange-50 hover:bg-orange-100 rounded-lg transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    {generatingSection === 'limitationsAndFutureWork' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-orange-600" />}
                    <span>Auto-Identify Limitations</span>
                  </button>
                </div>

                <div className="space-y-1.5">
                  {(Array.isArray(editableMetadata.limitationsAndFutureWork) ? editableMetadata.limitationsAndFutureWork : []).map((item: string, lIdx: number) => (
                    <div key={lIdx} className="flex items-center gap-2 bg-orange-50/40 p-1.5 border border-orange-100 rounded-xl">
                      <input
                        value={item || ''}
                        onChange={(e) => {
                          const list = [...(Array.isArray(editableMetadata.limitationsAndFutureWork) ? editableMetadata.limitationsAndFutureWork : [])];
                          list[lIdx] = e.target.value;
                          setEditableMetadata({ ...editableMetadata, limitationsAndFutureWork: list });
                        }}
                        className="w-full text-xs p-1.5 bg-white border border-slate-200 rounded-lg text-slate-800"
                        placeholder="Limitation or future research direction..."
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const list = [...(Array.isArray(editableMetadata.limitationsAndFutureWork) ? editableMetadata.limitationsAndFutureWork : [])];
                          list.splice(lIdx, 1);
                          setEditableMetadata({ ...editableMetadata, limitationsAndFutureWork: list });
                        }}
                        className="text-slate-400 hover:text-red-500 p-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

            </div>

          {/* Section 4: Glossary & FAQs */}
          <div className="p-5 bg-white rounded-2xl border border-slate-200 space-y-6">
              
              {/* Detailed Glossary */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                    <BookOpen className="w-3.5 h-3.5 text-indigo-600" /> Paper Glossary ({editableMetadata.glossary?.length || 0} Terms)
                  </h4>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleGenerateSection('generate-glossary', 'glossary')}
                      disabled={generatingSection === 'glossary'}
                      className="px-2.5 py-1 text-[11px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      {generatingSection === 'glossary' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-indigo-600" />}
                      <span>Auto-Generate Glossary</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const current = editableMetadata.glossary || [];
                        setEditableMetadata({
                          ...editableMetadata,
                          glossary: [...current, { term: '', definition: '' }]
                        });
                      }}
                      className="px-2 py-1 text-[11px] font-semibold text-blue-600 bg-blue-50 rounded-lg cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                <div className="space-y-2.5 max-h-[350px] overflow-y-auto pr-1">
                  {(editableMetadata.glossary || []).map((item: any, gIdx: number) => (
                    <div key={gIdx} className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <input
                          value={item.term || ''}
                          onChange={(e) => {
                            const glossary = [...(editableMetadata.glossary || [])];
                            glossary[gIdx] = { ...glossary[gIdx], term: e.target.value };
                            setEditableMetadata({ ...editableMetadata, glossary });
                          }}
                          className="w-full max-w-xs px-2.5 py-1 text-xs font-bold bg-white border border-slate-300 rounded-lg text-indigo-950"
                          placeholder="Term / Acronym"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const glossary = [...(editableMetadata.glossary || [])];
                            glossary.splice(gIdx, 1);
                            setEditableMetadata({ ...editableMetadata, glossary });
                          }}
                          className="text-slate-400 hover:text-red-500 p-1 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <textarea
                        rows={2}
                        value={item.definition || ''}
                        onChange={(e) => {
                          const glossary = [...(editableMetadata.glossary || [])];
                          glossary[gIdx] = { ...glossary[gIdx], definition: e.target.value };
                          setEditableMetadata({ ...editableMetadata, glossary });
                        }}
                        className="w-full text-xs p-2 bg-white border border-slate-200 rounded-lg text-slate-800 leading-relaxed"
                        placeholder="Definition..."
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* FAQs */}
              <div className="space-y-3 pt-4 border-t border-slate-200">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                    <HelpCircle className="w-3.5 h-3.5 text-purple-600" /> Research FAQs ({editableMetadata.faq?.length || 0} / 20)
                  </h4>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleGenerateSection('generate-faq', 'faq', { count: 20 })}
                      disabled={generatingSection === 'faq'}
                      className="px-2.5 py-1 text-[11px] font-semibold text-purple-700 bg-purple-50 hover:bg-purple-100 rounded-lg transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      {generatingSection === 'faq' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-purple-600" />}
                      <span>Auto-Generate 20 FAQs</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const current = editableMetadata.faq || [];
                        if (current.length >= 20) return;
                        setEditableMetadata({
                          ...editableMetadata,
                          faq: [...current, { question: '', answer: '' }]
                        });
                      }}
                      className="px-2 py-1 text-[11px] font-semibold text-blue-600 bg-blue-50 rounded-lg cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                <div className="space-y-2.5 max-h-[350px] overflow-y-auto pr-1">
                  {(editableMetadata.faq || []).map((faqItem: any, fIdx: number) => (
                    <div key={fIdx} className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-purple-700">Q#{fIdx + 1}</span>
                        <button
                          type="button"
                          onClick={() => {
                            const faq = [...(editableMetadata.faq || [])];
                            faq.splice(fIdx, 1);
                            setEditableMetadata({ ...editableMetadata, faq });
                          }}
                          className="text-slate-400 hover:text-red-500 p-1 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <input
                        value={faqItem.question || ''}
                        onChange={(e) => {
                          const faq = [...(editableMetadata.faq || [])];
                          faq[fIdx] = { ...faq[fIdx], question: e.target.value };
                          setEditableMetadata({ ...editableMetadata, faq });
                        }}
                        className="w-full px-2.5 py-1 text-xs font-bold bg-white border border-slate-300 rounded-lg text-slate-900"
                        placeholder="Question..."
                      />
                      <textarea
                        rows={2}
                        value={faqItem.answer || ''}
                        onChange={(e) => {
                          const faq = [...(editableMetadata.faq || [])];
                          faq[fIdx] = { ...faq[fIdx], answer: e.target.value };
                          setEditableMetadata({ ...editableMetadata, faq });
                        }}
                        className="w-full text-xs p-2 bg-white border border-slate-200 rounded-lg text-slate-800 leading-relaxed"
                        placeholder="Answer..."
                      />
                    </div>
                  ))}
                </div>
              </div>

            </div>

          {/* Section 5: SEO & Deployments */}
          <div className="p-5 bg-white rounded-2xl border border-slate-200 space-y-6">
              
              {/* Long Tail Keywords */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1">
                    <Tag className="w-3.5 h-3.5 text-cyan-600" /> Long-Tail Keywords
                  </span>
                  <button
                    type="button"
                    onClick={() => handleGenerateSection('generate-keywords', 'longTailKeywords')}
                    disabled={generatingSection === 'longTailKeywords'}
                    className="px-2.5 py-1 text-[11px] font-semibold text-cyan-700 bg-cyan-50 hover:bg-cyan-100 rounded-lg transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    {generatingSection === 'longTailKeywords' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-cyan-600" />}
                    <span>Auto-Generate</span>
                  </button>
                </div>
                <textarea
                  rows={2}
                  value={(Array.isArray(editableMetadata.longTailKeywords) ? editableMetadata.longTailKeywords : []).join(', ')}
                  onChange={(e) => setEditableMetadata({
                    ...editableMetadata,
                    longTailKeywords: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                  })}
                  className="w-full px-3 py-2 text-xs bg-slate-50/50 border border-slate-300 rounded-xl font-mono text-slate-800"
                  placeholder="comma-separated keywords..."
                />
              </div>

              {/* SEO & Funding */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-4 border-t border-slate-200">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-bold text-slate-900">SEO Description (Max 160 chars)</label>
                    <button
                      type="button"
                      onClick={() => handleGenerateSection('generate-seo', 'seoDescription')}
                      disabled={generatingSection === 'seoDescription'}
                      className="px-2 py-0.5 text-[10px] font-semibold text-cyan-700 bg-cyan-50 hover:bg-cyan-100 rounded-md transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      {generatingSection === 'seoDescription' ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Sparkles className="w-2.5 h-2.5 text-cyan-600" />}
                      <span>Auto-Generate</span>
                    </button>
                  </div>
                  <textarea 
                    value={editableMetadata.seoDescription || ''} 
                    onChange={(e) => setEditableMetadata({...editableMetadata, seoDescription: e.target.value})}
                    className="w-full px-3 py-2 text-xs bg-slate-50/50 border border-slate-300 rounded-xl"
                    rows={2}
                    maxLength={160}
                    placeholder="Snippet for search engines..."
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-bold text-slate-900">Funding Information</label>
                    <button
                      type="button"
                      onClick={() => handleGenerateSection('generate-funding', 'fundingInformation')}
                      disabled={generatingSection === 'fundingInformation'}
                      className="px-2 py-0.5 text-[10px] font-semibold text-purple-700 bg-purple-50 hover:bg-purple-100 rounded-md transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      {generatingSection === 'fundingInformation' ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Sparkles className="w-2.5 h-2.5 text-purple-600" />}
                      <span>Auto-Generate</span>
                    </button>
                  </div>
                  <textarea 
                    value={editableMetadata.fundingInformation || ''} 
                    onChange={(e) => setEditableMetadata({...editableMetadata, fundingInformation: e.target.value})}
                    className="w-full px-3 py-2 text-xs bg-slate-50/50 border border-slate-300 rounded-xl"
                    rows={2}
                    placeholder="Grants, agencies, support..."
                  />
                </div>
              </div>

              {/* Practical Deployments */}
              <div className="space-y-2 pt-4 border-t border-slate-200">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1">
                    <Rocket className="w-3.5 h-3.5 text-emerald-600" /> Real-World Applications & Workflows
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleGenerateSection('generate-applications', 'practicalApplications')}
                      disabled={generatingSection === 'practicalApplications'}
                      className="px-2.5 py-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      {generatingSection === 'practicalApplications' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-emerald-600" />}
                      <span>Auto-Generate</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const current = editableMetadata.practicalApplications || [];
                        setEditableMetadata({
                          ...editableMetadata,
                          practicalApplications: [...current, '']
                        });
                      }}
                      className="px-2 py-1 text-[11px] font-semibold text-emerald-600 bg-emerald-50 rounded-lg cursor-pointer"
                    >
                      <Plus className="w-3 h-3" /> Add
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  {(editableMetadata.practicalApplications || []).map((appItem: string, aIdx: number) => (
                    <div key={aIdx} className="flex items-center gap-2">
                      <input
                        value={appItem || ''}
                        onChange={(e) => {
                          const apps = [...(editableMetadata.practicalApplications || [])];
                          apps[aIdx] = e.target.value;
                          setEditableMetadata({ ...editableMetadata, practicalApplications: apps });
                        }}
                        className="w-full px-3 py-1.5 text-xs bg-slate-50/50 border border-slate-300 rounded-xl"
                        placeholder="Application scenario..."
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const apps = [...(editableMetadata.practicalApplications || [])];
                          apps.splice(aIdx, 1);
                          setEditableMetadata({ ...editableMetadata, practicalApplications: apps });
                        }}
                        className="text-slate-400 hover:text-red-500 p-1 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

            </div>

          {/* Bottom Step 4 Action Footer */}
          {authErrorInfo && (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-amber-900 space-y-3 shadow-xs">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <div className="text-xs font-bold uppercase tracking-wider text-amber-800">
                    {authErrorInfo.isIpRestricted 
                      ? 'Zenodo Datacenter IP Restriction (403)' 
                      : authErrorInfo.is403
                        ? 'Zenodo Token Permission Denied (403)' 
                        : 'Zenodo Authentication Required (401)'}
                  </div>
                  <div className="text-xs text-amber-900 leading-relaxed">
                    {authErrorInfo.isIpRestricted 
                      ? 'Zenodo Production has restricted direct API calls from cloud datacenter IPs. Please switch to Zenodo Sandbox.'
                      : authErrorInfo.is403
                        ? 'Your Personal Access Token was rejected by Zenodo because it lacks "deposit:write" and "deposit:actions" scopes, or belongs to a different Zenodo environment.'
                        : 'A valid Zenodo Personal Access Token is required to communicate with the live Zenodo repository. Please configure your token in API Settings.'}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-amber-200/80">
                <button
                  type="button"
                  onClick={() => {
                    setZenodoEnv('sandbox');
                    setShowApiSettings(true);
                    setTimeout(() => apiKeysRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
                  }}
                  className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-xl text-xs transition-all flex items-center gap-1.5 cursor-pointer shadow-xs"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Switch to Zenodo Sandbox</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShowApiSettings(true);
                    setTimeout(() => apiKeysRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
                  }}
                  className="px-3.5 py-1.5 bg-white hover:bg-slate-100 border border-amber-300 text-amber-900 font-bold rounded-xl text-xs transition-all flex items-center gap-1.5 cursor-pointer"
                >
                  <Key className="w-3.5 h-3.5 text-amber-700" />
                  <span>Configure Token in Settings</span>
                </button>
              </div>
            </div>
          )}

          <div className="pt-4 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3">
            <button
              type="button"
              onClick={handleStartOver}
              className="w-full sm:w-auto px-4 py-3 bg-white hover:bg-rose-50 border border-slate-200 hover:border-rose-200 text-rose-700 font-semibold rounded-xl text-xs transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs"
            >
              <X className="w-4 h-4" />
              <span>Discard & Choose New PDF</span>
            </button>

            <div className="flex flex-col sm:flex-row items-center gap-2 w-full sm:w-auto flex-1 justify-end">
              <button
                type="button"
                onClick={handleUploadToZenodo}
                disabled={isUploadingToZenodo}
                className="w-full sm:w-auto flex-1 px-6 py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 disabled:bg-slate-300 shadow-sm cursor-pointer disabled:cursor-not-allowed"
              >
                {isUploadingToZenodo ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudUpload className="w-4 h-4" />}
                <span>
                  {isUploadingToZenodo 
                    ? 'Publishing to Zenodo...' 
                    : 'Step 4: Upload to Zenodo & Mint DOI'}
                </span>
              </button>
            </div>
          </div>

          {!zenodoApiKey && (
            <p className="text-xs text-amber-700 text-center font-medium">
              Note: A Zenodo Personal Access Token is required to mint the DOI.{' '}
              <button
                type="button"
                onClick={() => setShowApiSettings(true)}
                className="underline font-bold text-amber-900 cursor-pointer"
              >
                Click here to configure token
              </button>
            </p>
          )}

        </div>
      )}

    </div>
  );
}
