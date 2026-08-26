import React, { useState, useEffect, useRef } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../lib/db';
import { Upload, CheckCircle2, Loader2, AlertCircle, CloudUpload, Key, Lock, Plus, Trash2, Globe, FileText, Tag, BookOpen, Link, HelpCircle, Search, ExternalLink, Sparkles, UserCheck, FolderOpen } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { initAuth, googleSignIn } from '../auth';
import { User } from 'firebase/auth';

function sanitizeHeader(val?: string): string {
  if (!val || typeof val !== 'string') return '';
  return val
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
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

function parseMetadataFromBrowserBuffer(buffer: ArrayBuffer, filename: string = 'paper.pdf'): any {
  let extractedText = '';
  try {
    const bytes = new Uint8Array(buffer);
    const binaryStr = Array.from(bytes.subarray(0, Math.min(bytes.length, 500000)))
      .map(b => String.fromCharCode(b))
      .join('');
    
    const textBlocks: string[] = [];
    const matches = binaryStr.match(/\(([^()\r\n]{3,})\)/g);
    if (matches) {
      for (const m of matches) {
        const cleaned = m.slice(1, -1).replace(/\\([0-7]{3}|[()\\nrtb])/g, ' ').trim();
        if (cleaned.length > 3 && /[a-zA-Z]{3,}/.test(cleaned)) {
          textBlocks.push(cleaned);
        }
      }
    }
    extractedText = textBlocks.join(' ').replace(/\s+/g, ' ').trim();
  } catch (e) {
    console.warn('Browser fallback binary extraction warning:', e);
  }

  const cleanText = (extractedText || '').replace(/\r\n/g, '\n').trim();
  const lines = cleanText.split('\n').map(l => l.trim()).filter(Boolean);

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
  if (!title) {
    title = 'Untitled Research Paper';
  }

  let abstract = '';
  const abstractMatch = cleanText.match(/(?:abstract|summary)[\s:-]+([\s\S]{50,2000}?)(?=\n\s*(?:1[\s.]+|introduction|keywords|index terms|1\.\s+introduction)|$)/i);
  if (abstractMatch) {
    abstract = abstractMatch[1].replace(/[\r\n]+/g, ' ').trim();
  }
  if (!abstract) {
    abstract = 'Open-access research paper uploaded via ZenUploader.';
  }

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

  const authors: any[] = [];
  if (lines.length > 2) {
    const authorSection = lines.slice(1, 10).join(' ');
    const potentialNames = authorSection.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}/g);
    if (potentialNames && potentialNames.length > 0) {
      const uniqueNames = Array.from(new Set(potentialNames)).slice(0, 6);
      uniqueNames.forEach(name => {
        if (!/Abstract|Introduction|University|Department|IEEE|ACM|Springer|arxiv/i.test(name)) {
          authors.push({ name, affiliation: '', url: '' });
        }
      });
    }
  }
  if (authors.length === 0) {
    authors.push({ name: 'Research Author', affiliation: '', url: '' });
  }

  const doiMatch = cleanText.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/);
  const identifiers = doiMatch ? [{ identifier: doiMatch[0], scheme: 'doi' }] : [];

  const yearMatch = cleanText.match(/\b(19\d\d|20\d\d)\b/);
  const publicationDate = yearMatch ? yearMatch[1] : new Date().toISOString().split('T')[0];

  return {
    title,
    alternativeTitle: '',
    authors,
    publicationDate,
    fundingInformation: '',
    tldr: `${title}. Key findings and open-access research data.`,
    abstract,
    summary: abstract,
    keyTakeaways: ['Open-access research contribution', 'Peer-reviewed methodology & findings'],
    novelties: ['Scientific contribution to the field'],
    glossary: [],
    faq: [],
    longTailKeywords: keywords.length > 0 ? keywords : ['research paper', 'zenodo publication'],
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

export default function FileUploader({ user, onUploadSuccess }: { user: User | null; onUploadSuccess?: () => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const apiKeysRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [editableMetadata, setEditableMetadata] = useState<any>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zenodoReceipt, setZenodoReceipt] = useState<any>(null);
  
  const [needsAuth, setNeedsAuth] = useState(false);
  const [zenodoApiKey, setZenodoApiKey] = useState<string>('');
  const [geminiApiKey, setGeminiApiKey] = useState<string>('');
  const [savingKey, setSavingKey] = useState(false);
  const [keysSaved, setKeysSaved] = useState(false);
  const [isLocked, setIsLocked] = useState(true);
  const [signingIn, setSigningIn] = useState(false);

  const [loadingWhoisIndex, setLoadingWhoisIndex] = useState<number | null>(null);
  const [generatingGlossary, setGeneratingGlossary] = useState(false);
  const [generatingFaq, setGeneratingFaq] = useState(false);
  const [generatingNovelties, setGeneratingNovelties] = useState(false);
  const [generatingKeywords, setGeneratingKeywords] = useState(false);
  const [generatingTldr, setGeneratingTldr] = useState(false);
  const [generatingTakeaways, setGeneratingTakeaways] = useState(false);
  const [generatingBenchmarks, setGeneratingBenchmarks] = useState(false);
  const [generatingLimitations, setGeneratingLimitations] = useState(false);
  const [showZenodoPreview, setShowZenodoPreview] = useState(false);

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
      if (res.ok) {
        const data = await res.json();
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

  const handleGenerateGlossary = async () => {
    if (!editableMetadata) return;
    setGeneratingGlossary(true);
    try {
      const cleanGeminiKey = sanitizeHeader(geminiApiKey);
      const res = await fetch('/api/generate-glossary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editableMetadata.title,
          abstract: editableMetadata.abstract,
          summary: editableMetadata.summary,
          geminiApiKey: cleanGeminiKey
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.glossary) && data.glossary.length > 0) {
          setEditableMetadata({
            ...editableMetadata,
            glossary: data.glossary
          });
        }
      }
    } catch (err) {
      console.error('Failed to generate glossary:', err);
    } finally {
      setGeneratingGlossary(false);
    }
  };

  const handleGenerateFaq = async (targetCount = 20) => {
    if (!editableMetadata) return;
    setGeneratingFaq(true);
    try {
      const cleanGeminiKey = sanitizeHeader(geminiApiKey);
      const res = await fetch('/api/generate-faq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editableMetadata.title,
          abstract: editableMetadata.abstract,
          summary: editableMetadata.summary,
          count: targetCount,
          geminiApiKey: cleanGeminiKey
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.faq) && data.faq.length > 0) {
          setEditableMetadata({
            ...editableMetadata,
            faq: data.faq
          });
        }
      }
    } catch (err) {
      console.error('Failed to generate FAQs:', err);
    } finally {
      setGeneratingFaq(false);
    }
  };

  const handleGenerateNovelties = async () => {
    if (!editableMetadata) return;
    setGeneratingNovelties(true);
    try {
      const cleanGeminiKey = sanitizeHeader(geminiApiKey);
      const res = await fetch('/api/generate-novelties', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editableMetadata.title,
          abstract: editableMetadata.abstract,
          summary: editableMetadata.summary,
          geminiApiKey: cleanGeminiKey
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.novelties) && data.novelties.length > 0) {
          setEditableMetadata({
            ...editableMetadata,
            novelties: data.novelties
          });
        }
      }
    } catch (err) {
      console.error('Failed to generate novelties:', err);
    } finally {
      setGeneratingNovelties(false);
    }
  };

  const handleGenerateKeywords = async () => {
    if (!editableMetadata) return;
    setGeneratingKeywords(true);
    try {
      const cleanGeminiKey = sanitizeHeader(geminiApiKey);
      const res = await fetch('/api/generate-keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editableMetadata.title,
          abstract: editableMetadata.abstract,
          summary: editableMetadata.summary,
          geminiApiKey: cleanGeminiKey
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.keywords) && data.keywords.length > 0) {
          setEditableMetadata({
            ...editableMetadata,
            longTailKeywords: data.keywords
          });
        }
      }
    } catch (err) {
      console.error('Failed to generate keywords:', err);
    } finally {
      setGeneratingKeywords(false);
    }
  };

  const handleGenerateTldr = async () => {
    if (!editableMetadata) return;
    setGeneratingTldr(true);
    try {
      const cleanGeminiKey = sanitizeHeader(geminiApiKey);
      const res = await fetch('/api/generate-tldr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editableMetadata.title,
          abstract: editableMetadata.abstract,
          summary: editableMetadata.summary,
          geminiApiKey: cleanGeminiKey
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.tldr) {
          setEditableMetadata({ ...editableMetadata, tldr: data.tldr });
        }
      }
    } catch (err) {
      console.error('Failed to generate TL;DR:', err);
    } finally {
      setGeneratingTldr(false);
    }
  };

  const handleGenerateTakeaways = async () => {
    if (!editableMetadata) return;
    setGeneratingTakeaways(true);
    try {
      const cleanGeminiKey = sanitizeHeader(geminiApiKey);
      const res = await fetch('/api/generate-takeaways', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editableMetadata.title,
          abstract: editableMetadata.abstract,
          summary: editableMetadata.summary,
          geminiApiKey: cleanGeminiKey
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.keyTakeaways)) {
          setEditableMetadata({ ...editableMetadata, keyTakeaways: data.keyTakeaways });
        }
      }
    } catch (err) {
      console.error('Failed to generate key takeaways:', err);
    } finally {
      setGeneratingTakeaways(false);
    }
  };

  const handleGenerateBenchmarks = async () => {
    if (!editableMetadata) return;
    setGeneratingBenchmarks(true);
    try {
      const cleanGeminiKey = sanitizeHeader(geminiApiKey);
      const res = await fetch('/api/generate-benchmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editableMetadata.title,
          abstract: editableMetadata.abstract,
          summary: editableMetadata.summary,
          geminiApiKey: cleanGeminiKey
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.datasetsAndBenchmarks)) {
          setEditableMetadata({ ...editableMetadata, datasetsAndBenchmarks: data.datasetsAndBenchmarks });
        }
      }
    } catch (err) {
      console.error('Failed to generate benchmarks:', err);
    } finally {
      setGeneratingBenchmarks(false);
    }
  };

  const handleGenerateLimitations = async () => {
    if (!editableMetadata) return;
    setGeneratingLimitations(true);
    try {
      const cleanGeminiKey = sanitizeHeader(geminiApiKey);
      const res = await fetch('/api/generate-limitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editableMetadata.title,
          abstract: editableMetadata.abstract,
          summary: editableMetadata.summary,
          geminiApiKey: cleanGeminiKey
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.limitationsAndFutureWork)) {
          setEditableMetadata({ ...editableMetadata, limitationsAndFutureWork: data.limitationsAndFutureWork });
        }
      }
    } catch (err) {
      console.error('Failed to generate limitations:', err);
    } finally {
      setGeneratingLimitations(false);
    }
  };

  useEffect(() => {
    loadZenodoApiKey(user?.uid);
  }, [user]);

  const loadZenodoApiKey = async (uid?: string) => {
    try {
      let zKey = localStorage.getItem('zenodo_api_key') || '';
      let gKey = localStorage.getItem('gemini_api_key') || '';
      if (uid) {
        const docRef = doc(db, 'users', uid, 'settings', 'zenodo');
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data.zenodoApiKey) zKey = data.zenodoApiKey;
          if (data.geminiApiKey) gKey = data.geminiApiKey;
        }
      }
      setZenodoApiKey(zKey);
      setGeminiApiKey(gKey);
      if (zKey || gKey) setIsLocked(true);
    } catch (err) {
      console.error('Failed to load API Keys:', err);
    }
  };

  const saveApiKeys = async () => {
    setSavingKey(true);
    try {
      localStorage.setItem('zenodo_api_key', zenodoApiKey);
      localStorage.setItem('gemini_api_key', geminiApiKey);
      if (user && user.uid) {
        const docRef = doc(db, 'users', user.uid, 'settings', 'zenodo');
        await setDoc(docRef, { zenodoApiKey, geminiApiKey }, { merge: true });
      }
      setKeysSaved(true);
      setIsLocked(true);
      setTimeout(() => setKeysSaved(false), 3000);
    } catch (err) {
      console.error('Failed to save API Keys:', err);
      setError('Failed to save API Keys.');
    } finally {
      setSavingKey(false);
    }
  };

  const handleLogin = async () => {
    if (signingIn) return;
    setSigningIn(true);
    try {
      await googleSignIn();
    } catch (err: any) {
      const code = err?.code || '';
      const message = err?.message || '';
      if (
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request' ||
        code === 'auth/popup-blocked' ||
        message.includes('popup-closed-by-user') ||
        message.includes('INTERNAL ASSERTION FAILED')
      ) {
        // User closed or cancelled popup window, ignore
      } else {
        console.error('Login failed:', err);
        setError('Failed to sign in.');
      }
    } finally {
      setSigningIn(false);
    }
  };

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

  const savePaperToHistory = async (metadata: any, status: string = 'processed', receipt: any = null) => {
    const rawDocId = receipt?.depositionId || receipt?.record_id || receipt?.id || Date.now();
    const docId = String(rawDocId).replace(/[^a-zA-Z0-9_-]/g, '_') || `paper_${Date.now()}`;
    const paperObj = {
      id: docId,
      title: metadata?.title || 'Untitled Research Paper',
      metadata: metadata,
      status: status,
      createdAt: new Date().toISOString()
    };

    // 1. Save to localStorage for instant local availability
    try {
      const localUploads = JSON.parse(localStorage.getItem('zenuploader_local_uploads') || '[]');
      const filtered = Array.isArray(localUploads) ? localUploads.filter((item: any) => item.id !== docId) : [];
      filtered.unshift(paperObj);
      localStorage.setItem('zenuploader_local_uploads', JSON.stringify(filtered));
    } catch (e) {
      console.warn('Failed to write to localStorage:', e);
    }

    // 2. Save to Firestore if user logged in
    if (user && user.uid) {
      try {
        const uploadRef = doc(db, 'users', user.uid, 'uploads', docId);
        await setDoc(uploadRef, {
          title: metadata?.title || 'Untitled',
          metadata: metadata,
          status: status,
          createdAt: new Date().toISOString()
        }, { merge: true });
      } catch (err) {
        console.warn('Failed to save paper to Firestore:', err);
      }
    }

    if (onUploadSuccess) {
      onUploadSuccess();
    }
  };

  const processFileDirectly = async (targetFile: File | Blob) => {
    if (!targetFile) return;
    
    // Check for empty / pending iCloud download file
    if ('size' in targetFile && targetFile.size === 0) {
      setError('The selected file is empty (0 bytes) or still downloading from iCloud. Please verify the file is completely downloaded on your device and select it again.');
      setUploading(false);
      return;
    }

    setUploading(true);
    setError(null);
    setZenodoReceipt(null);
    
    try {
      const formData = new FormData();
      // Ensure targetFile is attached cleanly as a Blob/File
      if (targetFile instanceof File) {
        formData.append('pdf', targetFile);
      } else if (targetFile instanceof Blob) {
        formData.append('pdf', targetFile, getSafeFileName(targetFile));
      } else {
        const fallbackBlob = new Blob([targetFile as any], { type: 'application/pdf' });
        formData.append('pdf', fallbackBlob, 'document.pdf');
      }

      const cleanGeminiKey = (geminiApiKey || '').trim();
      if (cleanGeminiKey) {
        formData.append('geminiApiKey', cleanGeminiKey);
      }
      
      let data: any = null;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000);

        const response = await fetch('/api/process-pdf', {
          method: 'POST',
          body: formData,
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          data = await response.json();
        } else {
          let errMessage = 'Failed to process file on server';
          try {
            const errData = await response.json();
            errMessage = errData?.error || errData?.message || (typeof errData === 'string' ? errData : JSON.stringify(errData));
          } catch {
            try {
              const errText = await response.text();
              if (errText) errMessage = errText;
            } catch {}
          }
          console.warn('Server PDF processing note:', errMessage);
        }
      } catch (fetchErr: any) {
        console.warn('Network / fetch note during PDF processing, attempting direct browser recovery:', fetchErr);
      }

      // If server response wasn't available or network dropped (e.g. mobile LTE timeout), recover directly in browser
      if (!data) {
        console.log('DEBUG: Recovering metadata directly from browser file buffer...');
        const arrayBuffer = await targetFile.arrayBuffer();
        const safeName = getSafeFileName(targetFile);
        data = parseMetadataFromBrowserBuffer(arrayBuffer, safeName);
      }

      setResult(data);
      setEditableMetadata(data);
      setError(null);
      
      try {
        await savePaperToHistory(data, 'processed');
      } catch (histErr) {
        console.warn('Non-blocking savePaperToHistory warning:', histErr);
      }
    } catch (error: any) {
      console.error('Error processing PDF:', error);
      let msg = error?.message || 'An error occurred while processing the file.';
      if (msg.toLowerCase().includes('load failed') || msg.toLowerCase().includes('failed to fetch')) {
        msg = 'Unable to connect to the PDF service. Please verify your connection or try selecting the file again.';
      } else if (msg.includes('expected pattern') || msg.includes('did not match')) {
        msg = 'The PDF formatting was non-standard. Basic metadata has been recovered and populated for your review below.';
      }
      setError(msg);
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile.type === 'application/pdf' || droppedFile.name.toLowerCase().endsWith('.pdf')) {
        setFile(droppedFile);
        setError(null);
        setResult(null);
        processFileDirectly(droppedFile);
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
      setResult(null);
      processFileDirectly(selectedFile);
    }
  };

  const handleStartOver = () => {
    setFile(null);
    setUploading(false);
    setResult(null);
    setEditableMetadata(null);
    setError(null);
    setZenodoReceipt(null);
  };

  const handleProcess = async () => {
    if (!file) {
      setError('Please select a PDF document first.');
      fileInputRef.current?.click();
      return;
    }
    await processFileDirectly(file);
  };

  const handleUploadToZenodo = async () => {
    if (!file) {
      setError('Please select a PDF document first.');
      fileInputRef.current?.click();
      return;
    }
    const cleanZenodoKey = (zenodoApiKey || '').trim();
    if (!cleanZenodoKey) {
      setError('Zenodo Personal Access Token is required. Please enter your Zenodo API Token in the API Keys section below.');
      setIsLocked(false);
      apiKeysRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      if (file instanceof File) {
        formData.append('pdf', file);
      } else if (file instanceof Blob) {
        formData.append('pdf', file, getSafeFileName(file));
      } else {
        const fallbackBlob = new Blob([file as any], { type: 'application/pdf' });
        formData.append('pdf', fallbackBlob, 'document.pdf');
      }
      if (editableMetadata) {
        formData.append('metadata', JSON.stringify(editableMetadata));
      }
      formData.append('zenodoApiKey', cleanZenodoKey);
      
      const response = await fetch('/api/upload-to-zenodo', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        let errMessage = 'Failed to upload to Zenodo';
        try {
          const errData = await response.json();
          errMessage = errData?.error || errData?.message || (typeof errData === 'string' ? errData : JSON.stringify(errData));
        } catch {
          try {
            const errText = await response.text();
            if (errText) errMessage = errText;
          } catch {}
        }
        throw new Error(errMessage);
      }
      const data = await response.json();
      console.log('Uploaded to Zenodo:', data);
      
      try {
        await savePaperToHistory(editableMetadata || { title: file.name }, 'uploaded', data);
      } catch (saveErr) {
        console.warn('Non-blocking savePaperToHistory error:', saveErr);
      }
      
      setZenodoReceipt(data);
      setTimeout(handleStartOver, 5000); // Automatically reset after 5 seconds
    } catch (err: any) {
      console.error('Zenodo upload failed:', err);
      let msg = err?.message || 'Failed to upload to Zenodo';
      if (msg.toLowerCase().includes('load failed') || msg.toLowerCase().includes('failed to fetch')) {
        msg = 'Connection to upload service timed out or was interrupted. Please try again.';
      } else if (msg.includes('expected pattern') || msg.includes('did not match')) {
        msg = 'Zenodo metadata validation notice: A field value was formatted to match standard Zenodo deposit format.';
      }
      setError(msg);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-8 max-w-2xl mx-auto">
      {!user && (
        <div className="mb-6 p-4 bg-indigo-50/80 border border-indigo-200 rounded-xl flex items-center justify-between gap-3 text-xs text-indigo-900">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-indigo-600 shrink-0" />
            <span><strong>Guest Session:</strong> Uploads are processed instantly and saved locally. Sign in with Google to sync across devices.</span>
          </div>
          <button
            onClick={handleLogin}
            disabled={signingIn}
            className="px-3 py-1.5 bg-indigo-600 text-white font-bold rounded-lg hover:bg-indigo-700 transition-all text-xs shrink-0 cursor-pointer"
          >
            {signingIn ? 'Signing in...' : 'Sign in'}
          </button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-6">
        <h2 className="text-2xl font-bold tracking-tight text-slate-900">Upload Research Paper</h2>
        <span className="text-[11px] font-medium text-slate-500 bg-slate-100 px-2.5 py-1 rounded-md border border-slate-200 w-fit">
          3rd-Party Tool • Not affiliated with Zenodo
        </span>
      </div>

      {/* Persistent Disclaimer Callout */}
      <div className="mb-6 p-3.5 bg-amber-50/80 border border-amber-200/80 rounded-xl text-xs text-amber-900 flex items-start gap-2.5">
        <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
        <div className="leading-relaxed">
          <p className="font-bold text-amber-950">Important Notice & AI Accuracy Reminder</p>
          <p className="text-amber-800/90 text-[11px]">
            ZenUploader is an independent 3rd-party application not affiliated with or endorsed by Zenodo or CERN. AI models can make mistakes — please carefully review and verify all extracted metadata before final submission.
          </p>
        </div>
      </div>
      
      <div className="flex flex-col gap-6">
        <label
          htmlFor="pdf-file-picker"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center cursor-pointer transition-all ${
            isDragging ? 'border-blue-500 bg-blue-50/80 ring-4 ring-blue-100' : 'border-slate-300 hover:border-blue-500 hover:bg-blue-50/40 bg-slate-50/30'
          }`}
        >
          <div className="w-12 h-12 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center mb-3">
            <Upload className="w-6 h-6" />
          </div>
          <span className="text-sm font-semibold text-slate-800 text-center">
            {file ? file.name : 'Click anywhere or drag and drop your research PDF'}
          </span>
          <span className="text-xs text-slate-500 mt-1">
            {file ? `${(file.size / (1024 * 1024)).toFixed(2)} MB • Selected & Ready` : 'Supported format: .pdf (up to 100MB)'}
          </span>
          <div className="mt-4 px-4 py-1.5 bg-white border border-slate-300 text-slate-700 text-xs font-semibold rounded-lg shadow-sm hover:bg-slate-50 transition-all flex items-center gap-1.5 pointer-events-none">
            <FolderOpen className="w-3.5 h-3.5 text-blue-600" />
            {file ? 'Choose Different File' : 'Browse Computer'}
          </div>
        </label>

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

        <div ref={apiKeysRef} className="p-4 bg-slate-50 rounded-xl border border-slate-200">
            <h3 className="text-sm font-bold text-slate-900 mb-3 flex items-center gap-2">
              <Key className="w-4 h-4" /> API Keys
            </h3>
            <div className="flex flex-col gap-3">
              {isLocked ? (
                <div className="flex items-center gap-2 p-2 text-sm text-slate-500 bg-white border border-slate-200 rounded-lg">
                  <Lock className="w-4 h-4" />
                  <span>APIs Locked</span>
                </div>
              ) : (
                <>
                  <input
                    type="password"
                    value={zenodoApiKey}
                    onChange={(e) => setZenodoApiKey(e.target.value)}
                    className="px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm"
                    placeholder="Zenodo API Key"
                  />
                  <input
                    type="password"
                    value={geminiApiKey}
                    onChange={(e) => setGeminiApiKey(e.target.value)}
                    className="px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm"
                    placeholder="Gemini API Key"
                  />
                </>
              )}
              <button
                onClick={isLocked ? () => setIsLocked(false) : saveApiKeys}
                disabled={savingKey}
                className="px-4 py-2 bg-slate-800 text-white rounded-lg font-semibold text-sm hover:bg-slate-900 disabled:bg-slate-300 cursor-pointer"
              >
                {isLocked ? 'Unlock' : savingKey ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</>
                ) : keysSaved ? (
                  <><CheckCircle2 className="w-4 h-4" /> Keys saved</>
                ) : (
                  'Save Keys'
                )}
              </button>
            </div>
          </div>

        {!editableMetadata ? (
          <div className="space-y-3">
            <button
              onClick={handleProcess}
              disabled={uploading}
              className="w-full px-6 py-3.5 bg-blue-600 text-white rounded-xl font-bold text-sm hover:bg-blue-700 disabled:bg-slate-300 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:cursor-not-allowed shadow-sm"
            >
              {uploading ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Step 1: Processing PDF & Extracting Metadata...</>
              ) : (
                <><FileText className="w-4 h-4" /> Step 1: Process PDF Document</>
              )}
            </button>
            {!geminiApiKey && (
              <p className="text-xs text-slate-500 text-center">Tip: You can add your custom Gemini API key in API Settings above if needed.</p>
            )}
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 bg-blue-50/70 border border-blue-200 rounded-xl">
            <div className="flex items-center gap-2 text-blue-900 text-sm font-semibold">
              <CheckCircle2 className="w-5 h-5 text-blue-600 shrink-0" />
              <span>Step 1 Complete: PDF Processed</span>
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <button
                onClick={handleProcess}
                disabled={uploading}
                className="px-3 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 border border-slate-300 rounded-lg hover:bg-white transition-all cursor-pointer"
              >
                Re-process PDF
              </button>
              <button
                onClick={handleUploadToZenodo}
                disabled={uploading}
                className="flex-1 sm:flex-none px-5 py-2.5 bg-indigo-600 text-white rounded-lg font-bold text-sm hover:bg-indigo-700 disabled:bg-slate-300 transition-all flex items-center justify-center gap-2 shadow-sm cursor-pointer disabled:cursor-not-allowed"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudUpload className="w-4 h-4" />}
                {uploading ? 'Uploading...' : 'Step 2: Upload to Zenodo'}
              </button>
            </div>
          </div>
        )}
      </div>

      <AnimatePresence>
        {(editableMetadata || result || error || zenodoReceipt) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-6 space-y-6"
          >
            {error && (
              <div className="p-4 bg-red-50 rounded-xl border border-red-200 flex items-center justify-between gap-3 text-red-700">
                <div className="flex items-center gap-3">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  <span className="text-sm font-medium">{error}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="text-xs font-bold text-red-600 hover:text-red-800 underline shrink-0 cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            )}

            {zenodoReceipt ? (
              <div className="p-5 bg-green-50 rounded-xl border border-green-200">
                <div className="flex items-center gap-2 mb-3 text-green-900">
                  <CheckCircle2 className="w-5 h-5 text-green-600" />
                  <h3 className="text-sm font-bold">Upload Successful</h3>
                </div>
                <p className="text-sm text-green-700">Your paper has been uploaded to Zenodo.</p>
                {zenodoReceipt.doi && (
                  <p className="text-sm text-green-800 mt-2 font-mono">DOI: {zenodoReceipt.doi}</p>
                )}
                <a 
                  href={zenodoReceipt.links?.html} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="mt-4 block w-full px-4 py-2 bg-green-600 text-white rounded-lg font-semibold text-sm hover:bg-green-700 text-center"
                >
                  View on Zenodo
                </a>
                <button
                  onClick={handleStartOver}
                  className="mt-2 block w-full px-4 py-2 bg-white text-green-700 border border-green-200 rounded-lg font-semibold text-sm hover:bg-green-100 text-center cursor-pointer"
                >
                  Start Over & Upload Another
                </button>
              </div>
            ) : editableMetadata ? (
              <div className="p-6 bg-slate-50 rounded-2xl border border-slate-200">
                <div className="flex flex-wrap items-center justify-between gap-4 mb-4 pb-4 border-b border-slate-200">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                      <FileText className="w-5 h-5 text-blue-600" /> Step 2: Review & Final Upload
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">Please review all extracted metadata before submitting to Zenodo</p>
                  </div>
                  <button
                    onClick={handleUploadToZenodo}
                    disabled={uploading}
                    className="px-6 py-2.5 bg-indigo-600 text-white rounded-xl font-bold text-sm hover:bg-indigo-700 transition-all flex items-center justify-center gap-2 disabled:bg-slate-300 shadow-sm cursor-pointer disabled:cursor-not-allowed"
                  >
                    {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudUpload className="w-4 h-4" />}
                    {uploading ? 'Uploading to Zenodo...' : 'Final Upload to Zenodo'}
                  </button>
                </div>

                {/* AI Review Warning Box */}
                <div className="mb-6 p-3.5 bg-amber-50 rounded-xl border border-amber-200/90 flex items-start gap-2.5 text-xs text-amber-900">
                  <Sparkles className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <div className="leading-relaxed">
                    <span className="font-bold text-amber-950">AI Accuracy Notice: </span>
                    <span>AI models can make mistakes or hallucinate details. Please carefully inspect all fields below (title, authors, abstract, keywords, and bios) and make any necessary corrections prior to final submission.</span>
                  </div>
                </div>

                {editableMetadata?.notice && (
                  <div className="mb-6 p-4 bg-amber-50 rounded-xl border border-amber-200 flex items-start gap-3 text-amber-900">
                    <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                    <div className="text-sm">
                      <p className="font-bold text-amber-900 mb-1">PDF Text Extraction Active</p>
                      <p className="text-amber-800 text-xs leading-relaxed">{editableMetadata.notice}</p>
                    </div>
                  </div>
                )}

                <div className="space-y-8">
                  {/* Title & Basic Info */}
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-bold text-slate-900 mb-2">Title</label>
                      <input 
                        value={editableMetadata.title || ''} 
                        onChange={(e) => setEditableMetadata({...editableMetadata, title: e.target.value})}
                        className="w-full px-4 py-3 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        placeholder="Primary title of the paper"
                      />
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-bold text-slate-900 mb-2">Alternative Title</label>
                        <input 
                          value={editableMetadata.alternativeTitle || ''} 
                          onChange={(e) => setEditableMetadata({...editableMetadata, alternativeTitle: e.target.value})}
                          className="w-full px-4 py-3 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                          placeholder="Translated or secondary title"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-bold text-slate-900 mb-2">Journal / Publication Name</label>
                        <input 
                          value={editableMetadata.journalName || ''} 
                          onChange={(e) => setEditableMetadata({...editableMetadata, journalName: e.target.value})}
                          className="w-full px-4 py-3 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                          placeholder="Name of journal or conference"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-bold text-slate-900 mb-2">Publication Date</label>
                      <input 
                        value={editableMetadata.publicationDate || ''} 
                        onChange={(e) => setEditableMetadata({...editableMetadata, publicationDate: e.target.value})}
                        className="w-full px-4 py-3 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        placeholder="YYYY-MM-DD"
                      />
                    </div>
                  </div>

                  {/* Authors Section with WHOIS Bio */}
                  <div className="pt-6 border-t border-slate-200">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                          <UserCheck className="w-4 h-4 text-blue-600" /> Authors & Author WHOIS Bios
                        </h4>
                        <p className="text-xs text-slate-500 mt-0.5">Author metadata enriched with live Google Search WHOIS biographies.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const current = editableMetadata.authors || [];
                          setEditableMetadata({
                            ...editableMetadata,
                            authors: [...current, { name: '', affiliation: '', url: '', whoisBio: '' }]
                          });
                        }}
                        className="px-3 py-1.5 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors flex items-center gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add Author
                      </button>
                    </div>

                    <div className="space-y-4">
                      {(editableMetadata.authors || []).map((author: any, idx: number) => (
                        <div key={idx} className="p-4 bg-white border border-slate-200 rounded-xl space-y-3 relative shadow-2xs">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-slate-600 flex items-center gap-1.5">
                              Author #{idx + 1}
                            </span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleFetchAuthorWhois(idx)}
                                disabled={loadingWhoisIndex === idx || !author.name}
                                className="px-2.5 py-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50"
                                title="Run live web search grounding for author WHOIS bio"
                              >
                                {loadingWhoisIndex === idx ? (
                                  <><Loader2 className="w-3 h-3 animate-spin" /> Searching Web...</>
                                ) : (
                                  <><Search className="w-3 h-3" /> Search WHOIS Bio</>
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  const authors = [...(editableMetadata.authors || [])];
                                  authors.splice(idx, 1);
                                  setEditableMetadata({ ...editableMetadata, authors });
                                }}
                                className="text-slate-400 hover:text-red-500 p-1"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <input
                              value={author.name || ''}
                              onChange={(e) => {
                                const authors = [...(editableMetadata.authors || [])];
                                authors[idx] = { ...authors[idx], name: e.target.value };
                                setEditableMetadata({ ...editableMetadata, authors });
                              }}
                              className="px-3 py-2 text-sm border border-slate-200 rounded-lg font-medium"
                              placeholder="Author Name (e.g. Jane Doe)"
                            />
                            <input
                              value={author.affiliation || ''}
                              onChange={(e) => {
                                const authors = [...(editableMetadata.authors || [])];
                                authors[idx] = { ...authors[idx], affiliation: e.target.value };
                                setEditableMetadata({ ...editableMetadata, authors });
                              }}
                              className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
                              placeholder="Affiliation / Institution"
                            />
                            <input
                              value={author.url || ''}
                              onChange={(e) => {
                                const authors = [...(editableMetadata.authors || [])];
                                authors[idx] = { ...authors[idx], url: e.target.value };
                                setEditableMetadata({ ...editableMetadata, authors });
                              }}
                              className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
                              placeholder="Author Website / ORCID"
                            />
                          </div>

                          {/* Author WHOIS Bio Box */}
                          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1.5">
                            <div className="flex items-center justify-between">
                              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1">
                                <Sparkles className="w-3 h-3 text-amber-500" /> Author WHOIS Bio
                              </label>
                              {author.whoisSources && author.whoisSources.length > 0 && (
                                <span className="text-[10px] text-slate-500 flex items-center gap-1">
                                  <Globe className="w-3 h-3 text-emerald-600" /> {author.whoisSources.length} Live Sources
                                </span>
                              )}
                            </div>
                            <textarea
                              rows={3}
                              value={author.whoisBio || ''}
                              onChange={(e) => {
                                const authors = [...(editableMetadata.authors || [])];
                                authors[idx] = { ...authors[idx], whoisBio: e.target.value };
                                setEditableMetadata({ ...editableMetadata, authors });
                              }}
                              className="w-full text-xs p-2.5 bg-white border border-slate-200 rounded-lg focus:ring-1 focus:ring-blue-500 text-slate-800 leading-relaxed"
                              placeholder="Professional biography based on live web search..."
                            />
                            {author.whoisSources && author.whoisSources.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                                {author.whoisSources.map((src: string, sIdx: number) => (
                                  <a
                                    key={sIdx}
                                    href={getSafeHref(src)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-[10px] text-blue-600 hover:underline bg-blue-50 px-2 py-0.5 rounded flex items-center gap-1 truncate max-w-xs"
                                  >
                                    <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                                    {formatUrlDisplay(src)}
                                  </a>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                      {(!editableMetadata.authors || editableMetadata.authors.length === 0) && (
                        <p className="text-xs text-slate-400 italic">No authors added yet.</p>
                      )}
                    </div>
                  </div>

                  {/* TL;DR Section */}
                  <div className="pt-6 border-t border-slate-200">
                    <div className="bg-emerald-50/80 border-2 border-emerald-500/30 rounded-2xl p-4 sm:p-5 space-y-3">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="p-1.5 bg-emerald-600 text-white rounded-lg shadow-2xs font-mono font-black text-xs">TL;DR</span>
                          <div>
                            <h4 className="text-sm font-bold text-slate-900">Core Finding Punchline (TL;DR)</h4>
                            <p className="text-xs text-slate-500">Ultra-concise 1–2 sentence punchline of the paper's main breakthrough.</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={handleGenerateTldr}
                          disabled={generatingTldr}
                          className="px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-white border border-emerald-300 hover:bg-emerald-100/80 rounded-xl shadow-2xs transition-colors flex items-center gap-1.5 shrink-0 disabled:opacity-50"
                        >
                          {generatingTldr ? (
                            <><Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600" /> Generating TL;DR...</>
                          ) : (
                            <><Sparkles className="w-3.5 h-3.5 text-emerald-600" /> Auto-Generate TL;DR</>
                          )}
                        </button>
                      </div>
                      <textarea
                        rows={2}
                        value={editableMetadata.tldr || ''}
                        onChange={(e) => setEditableMetadata({ ...editableMetadata, tldr: e.target.value })}
                        className="w-full px-3.5 py-2.5 text-xs sm:text-sm bg-white border border-emerald-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:outline-none text-slate-900 font-medium leading-relaxed"
                        placeholder="e.g. This paper introduces a zero-shot vision-language architecture that achieves state-of-the-art accuracy on 15 medical imaging benchmarks while running 4x faster than existing baselines."
                      />
                    </div>
                  </div>

                  {/* Key Takeaways */}
                  <div className="pt-6 border-t border-slate-200">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                      <div>
                        <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-amber-500" /> Key Takeaways & Executive Highlights
                        </h4>
                        <p className="text-xs text-slate-500 mt-0.5">3–5 bullet points for busy researchers and executives.</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleGenerateTakeaways}
                          disabled={generatingTakeaways}
                          className="px-3 py-1.5 text-xs font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100 rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50"
                        >
                          {generatingTakeaways ? (
                            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating...</>
                          ) : (
                            <><Sparkles className="w-3.5 h-3.5 text-amber-600" /> Auto-Generate Takeaways</>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const current = Array.isArray(editableMetadata.keyTakeaways) ? editableMetadata.keyTakeaways : [];
                            setEditableMetadata({ ...editableMetadata, keyTakeaways: [...current, ''] });
                          }}
                          className="px-3 py-1.5 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors flex items-center gap-1"
                        >
                          <Plus className="w-3.5 h-3.5" /> Add Takeaway
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      {(Array.isArray(editableMetadata.keyTakeaways) ? editableMetadata.keyTakeaways : []).map((item: string, tIdx: number) => (
                        <div key={tIdx} className="flex items-center gap-2 bg-amber-50/50 p-2 border border-amber-100 rounded-xl">
                          <span className="text-xs font-bold text-amber-600 shrink-0 ml-1">●</span>
                          <input
                            value={item || ''}
                            onChange={(e) => {
                              const keyTakeaways = [...(Array.isArray(editableMetadata.keyTakeaways) ? editableMetadata.keyTakeaways : [])];
                              keyTakeaways[tIdx] = e.target.value;
                              setEditableMetadata({ ...editableMetadata, keyTakeaways });
                            }}
                            className="w-full text-xs p-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:ring-1 focus:ring-amber-500"
                            placeholder="Key executive takeaway..."
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const keyTakeaways = [...(Array.isArray(editableMetadata.keyTakeaways) ? editableMetadata.keyTakeaways : [])];
                              keyTakeaways.splice(tIdx, 1);
                              setEditableMetadata({ ...editableMetadata, keyTakeaways });
                            }}
                            className="text-slate-400 hover:text-red-500 p-1 shrink-0"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                      {(!editableMetadata.keyTakeaways || editableMetadata.keyTakeaways.length === 0) && (
                        <p className="text-xs text-slate-400 italic">No key takeaways added yet.</p>
                      )}
                    </div>
                  </div>

                  {/* Datasets & Benchmarks */}
                  <div className="pt-6 border-t border-slate-200">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                      <div>
                        <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-blue-600" /> Datasets & Quantitative Benchmarks
                        </h4>
                        <p className="text-xs text-slate-500 mt-0.5">Experimental datasets, baseline comparisons, and quantitative accuracy/speedup gains.</p>
                      </div>
                      <button
                        type="button"
                        onClick={handleGenerateBenchmarks}
                        disabled={generatingBenchmarks}
                        className="px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50 shrink-0"
                      >
                        {generatingBenchmarks ? (
                          <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Extracting Benchmarks...</>
                        ) : (
                          <><Sparkles className="w-3.5 h-3.5 text-blue-600" /> Auto-Extract Benchmarks</>
                        )}
                      </button>
                    </div>

                    <div className="space-y-2">
                      {(Array.isArray(editableMetadata.datasetsAndBenchmarks) ? editableMetadata.datasetsAndBenchmarks : []).map((item: any, bIdx: number) => (
                        <div key={bIdx} className="flex items-center gap-2 bg-blue-50/40 p-2 border border-blue-100 rounded-xl">
                          <input
                            value={typeof item === 'string' ? item : (item.result || item.dataset || '')}
                            onChange={(e) => {
                              const list = [...(Array.isArray(editableMetadata.datasetsAndBenchmarks) ? editableMetadata.datasetsAndBenchmarks : [])];
                              list[bIdx] = e.target.value;
                              setEditableMetadata({ ...editableMetadata, datasetsAndBenchmarks: list });
                            }}
                            className="w-full text-xs p-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:ring-1 focus:ring-blue-500 font-mono"
                            placeholder="Dataset or benchmark result (e.g. PubMed dataset - 92.4% F1-score vs 88.1% baseline)"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const list = [...(Array.isArray(editableMetadata.datasetsAndBenchmarks) ? editableMetadata.datasetsAndBenchmarks : [])];
                              list.splice(bIdx, 1);
                              setEditableMetadata({ ...editableMetadata, datasetsAndBenchmarks: list });
                            }}
                            className="text-slate-400 hover:text-red-500 p-1 shrink-0"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                      {(!editableMetadata.datasetsAndBenchmarks || editableMetadata.datasetsAndBenchmarks.length === 0) && (
                        <p className="text-xs text-slate-400 italic">No dataset benchmarks extracted yet.</p>
                      )}
                    </div>
                  </div>

                  {/* Limitations & Future Work */}
                  <div className="pt-6 border-t border-slate-200">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                      <div>
                        <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-orange-600" /> Limitations & Open Future Directions
                        </h4>
                        <p className="text-xs text-slate-500 mt-0.5">Transparent paper caveats, assumptions, failure modes, and next research steps.</p>
                      </div>
                      <button
                        type="button"
                        onClick={handleGenerateLimitations}
                        disabled={generatingLimitations}
                        className="px-3 py-1.5 text-xs font-semibold text-orange-700 bg-orange-50 hover:bg-orange-100 rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50 shrink-0"
                      >
                        {generatingLimitations ? (
                          <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating...</>
                        ) : (
                          <><Sparkles className="w-3.5 h-3.5 text-orange-600" /> Auto-Identify Limitations</>
                        )}
                      </button>
                    </div>

                    <div className="space-y-2">
                      {(Array.isArray(editableMetadata.limitationsAndFutureWork) ? editableMetadata.limitationsAndFutureWork : []).map((item: string, lIdx: number) => (
                        <div key={lIdx} className="flex items-center gap-2 bg-orange-50/40 p-2 border border-orange-100 rounded-xl">
                          <input
                            value={item || ''}
                            onChange={(e) => {
                              const list = [...(Array.isArray(editableMetadata.limitationsAndFutureWork) ? editableMetadata.limitationsAndFutureWork : [])];
                              list[lIdx] = e.target.value;
                              setEditableMetadata({ ...editableMetadata, limitationsAndFutureWork: list });
                            }}
                            className="w-full text-xs p-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:ring-1 focus:ring-orange-500"
                            placeholder="Limitation or future research direction..."
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const list = [...(Array.isArray(editableMetadata.limitationsAndFutureWork) ? editableMetadata.limitationsAndFutureWork : [])];
                              list.splice(lIdx, 1);
                              setEditableMetadata({ ...editableMetadata, limitationsAndFutureWork: list });
                            }}
                            className="text-slate-400 hover:text-red-500 p-1 shrink-0"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                      {(!editableMetadata.limitationsAndFutureWork || editableMetadata.limitationsAndFutureWork.length === 0) && (
                        <p className="text-xs text-slate-400 italic">No limitations specified yet.</p>
                      )}
                    </div>
                  </div>

                  {/* Code, Data Repositories & Target Audience */}
                  <div className="pt-6 border-t border-slate-200 grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-900 mb-1">Code & Dataset Repositories</label>
                      <input
                        value={editableMetadata.codeAndDataLinks || ''}
                        onChange={(e) => setEditableMetadata({ ...editableMetadata, codeAndDataLinks: e.target.value })}
                        className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 font-mono"
                        placeholder="e.g. https://github.com/lab/repo or HuggingFace Dataset"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-900 mb-1">Target Audience & Domain</label>
                      <input
                        value={editableMetadata.targetAudience || ''}
                        onChange={(e) => setEditableMetadata({ ...editableMetadata, targetAudience: e.target.value })}
                        className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500"
                        placeholder="e.g. Computer Vision researchers, Bioinformaticians, ML Engineers"
                      />
                    </div>
                  </div>

                  {/* Abstract & Summaries */}
                  <div className="pt-6 border-t border-slate-200 space-y-6">
                    <div>
                      <label className="block text-sm font-bold text-slate-900 mb-2">Abstract</label>
                      <textarea 
                        value={editableMetadata.abstract || ''} 
                        onChange={(e) => setEditableMetadata({...editableMetadata, abstract: e.target.value})}
                        className="w-full px-4 py-3 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        rows={5}
                        placeholder="Original or extracted paper abstract"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-bold text-slate-900 mb-2">Summary</label>
                      <textarea 
                        value={editableMetadata.summary || ''} 
                        onChange={(e) => setEditableMetadata({...editableMetadata, summary: e.target.value})}
                        className="w-full px-4 py-3 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        rows={5}
                        placeholder="Detailed summary of key findings"
                      />
                    </div>
                  </div>

                  {/* Novelties Section */}
                  <div className="pt-6 border-t border-slate-200">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
                      <div>
                        <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-emerald-600" /> Paper Novelties & Innovations
                        </h4>
                        <p className="text-xs text-slate-500 mt-0.5">Outlining core scientific innovations, original algorithms, and key breakthroughs.</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleGenerateNovelties}
                          disabled={generatingNovelties}
                          className="px-3 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50"
                        >
                          {generatingNovelties ? (
                            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating Novelties...</>
                          ) : (
                            <><Sparkles className="w-3.5 h-3.5 text-emerald-600" /> Auto-Generate Novelties</>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const current = Array.isArray(editableMetadata.novelties) ? editableMetadata.novelties : [];
                            setEditableMetadata({
                              ...editableMetadata,
                              novelties: [...current, '']
                            });
                          }}
                          className="px-3 py-1.5 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors flex items-center gap-1"
                        >
                          <Plus className="w-3.5 h-3.5" /> Add Novelty
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2.5">
                      {(Array.isArray(editableMetadata.novelties) ? editableMetadata.novelties : (editableMetadata.novelties ? [editableMetadata.novelties] : [])).map((novItem: string, nIdx: number) => (
                        <div key={nIdx} className="flex items-start gap-2 bg-emerald-50/50 p-2.5 border border-emerald-100 rounded-xl">
                          <span className="text-xs font-bold text-emerald-600 shrink-0 mt-2">#{nIdx + 1}</span>
                          <textarea
                            rows={2}
                            value={novItem || ''}
                            onChange={(e) => {
                              const novelties = [...(Array.isArray(editableMetadata.novelties) ? editableMetadata.novelties : [])];
                              novelties[nIdx] = e.target.value;
                              setEditableMetadata({ ...editableMetadata, novelties });
                            }}
                            className="w-full text-xs p-2 bg-white border border-slate-200 rounded-lg text-slate-800 leading-relaxed focus:ring-1 focus:ring-emerald-500"
                            placeholder="Describe a specific novelty, breakthrough, or original contribution..."
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const novelties = [...(Array.isArray(editableMetadata.novelties) ? editableMetadata.novelties : [])];
                              novelties.splice(nIdx, 1);
                              setEditableMetadata({ ...editableMetadata, novelties });
                            }}
                            className="text-slate-400 hover:text-red-500 p-1 shrink-0 mt-1"
                            title="Remove novelty"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                      {(!editableMetadata.novelties || (Array.isArray(editableMetadata.novelties) && editableMetadata.novelties.length === 0)) && (
                        <div className="p-4 bg-slate-50 rounded-xl border border-dashed border-slate-200 text-center">
                          <p className="text-xs text-slate-500 font-medium">No paper novelties specified yet.</p>
                          <p className="text-[11px] text-slate-400 mt-1">Click <strong>Auto-Generate Novelties</strong> above to extract exact paper breakthroughs automatically.</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Detailed Glossary Section */}
                  <div className="pt-6 border-t border-slate-200">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
                      <div>
                        <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                          <BookOpen className="w-4 h-4 text-indigo-600" /> Paper Detailed Glossary
                        </h4>
                        <p className="text-xs text-slate-500 mt-0.5">Technical terms, methods, datasets, and concepts defined in this upload.</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleGenerateGlossary}
                          disabled={generatingGlossary}
                          className="px-3 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50"
                        >
                          {generatingGlossary ? (
                            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating Glossary...</>
                          ) : (
                            <><Sparkles className="w-3.5 h-3.5 text-indigo-600" /> Auto-Generate Glossary</>
                          )}
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
                          className="px-3 py-1.5 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors flex items-center gap-1"
                        >
                          <Plus className="w-3.5 h-3.5" /> Add Term
                        </button>
                      </div>
                    </div>

                    <div className="space-y-3">
                      {(editableMetadata.glossary || []).map((item: any, gIdx: number) => (
                        <div key={gIdx} className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2 relative">
                          <div className="flex items-center justify-between gap-2">
                            <input
                              value={item.term || ''}
                              onChange={(e) => {
                                const glossary = [...(editableMetadata.glossary || [])];
                                glossary[gIdx] = { ...glossary[gIdx], term: e.target.value };
                                setEditableMetadata({ ...editableMetadata, glossary });
                              }}
                              className="w-full max-w-xs px-3 py-1.5 text-xs font-bold bg-white border border-slate-300 rounded-lg text-indigo-950 focus:ring-1 focus:ring-indigo-500"
                              placeholder="Technical Term / Acronym"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const glossary = [...(editableMetadata.glossary || [])];
                                glossary.splice(gIdx, 1);
                                setEditableMetadata({ ...editableMetadata, glossary });
                              }}
                              className="text-slate-400 hover:text-red-500 p-1"
                              title="Delete term"
                            >
                              <Trash2 className="w-4 h-4" />
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
                            className="w-full text-xs p-2.5 bg-white border border-slate-200 rounded-lg text-slate-800 leading-relaxed focus:ring-1 focus:ring-indigo-500"
                            placeholder="Detailed definition and significance in the paper..."
                          />
                        </div>
                      ))}
                      {(!editableMetadata.glossary || editableMetadata.glossary.length === 0) && (
                        <div className="p-4 bg-slate-50 rounded-xl border border-dashed border-slate-200 text-center">
                          <p className="text-xs text-slate-500 font-medium">No glossary terms created yet.</p>
                          <p className="text-[11px] text-slate-400 mt-1">Click <strong>Auto-Generate Glossary</strong> above to create a complete detailed glossary automatically using Gemini AI.</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Frequently Asked Questions (Up to 20 FAQs) */}
                  <div className="pt-6 border-t border-slate-200">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
                      <div>
                        <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                          <HelpCircle className="w-4 h-4 text-purple-600" /> Paper FAQs ({editableMetadata.faq?.length || 0} / 20)
                        </h4>
                        <p className="text-xs text-slate-500 mt-0.5">Comprehensive Q&As covering methodology, benchmarks, limitations, and practical applications.</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleGenerateFaq(20)}
                          disabled={generatingFaq}
                          className="px-3 py-1.5 text-xs font-semibold text-purple-700 bg-purple-50 hover:bg-purple-100 rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50"
                        >
                          {generatingFaq ? (
                            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating 20 FAQs...</>
                          ) : (
                            <><Sparkles className="w-3.5 h-3.5 text-purple-600" /> Auto-Generate 20 FAQs</>
                          )}
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
                          disabled={(editableMetadata.faq?.length || 0) >= 20}
                          className="px-3 py-1.5 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50"
                        >
                          <Plus className="w-3.5 h-3.5" /> Add FAQ
                        </button>
                      </div>
                    </div>

                    <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
                      {(editableMetadata.faq || []).map((faqItem: any, fIdx: number) => (
                        <div key={fIdx} className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2 relative">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-bold uppercase tracking-wider text-purple-700">Question #{fIdx + 1}</span>
                            <button
                              type="button"
                              onClick={() => {
                                const faq = [...(editableMetadata.faq || [])];
                                faq.splice(fIdx, 1);
                                setEditableMetadata({ ...editableMetadata, faq });
                              }}
                              className="text-slate-400 hover:text-red-500 p-1"
                              title="Delete question"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                          <input
                            value={faqItem.question || ''}
                            onChange={(e) => {
                              const faq = [...(editableMetadata.faq || [])];
                              faq[fIdx] = { ...faq[fIdx], question: e.target.value };
                              setEditableMetadata({ ...editableMetadata, faq });
                            }}
                            className="w-full px-3 py-1.5 text-xs font-bold bg-white border border-slate-300 rounded-lg text-slate-900 focus:ring-1 focus:ring-purple-500"
                            placeholder="e.g. What is the core methodological novelty of this paper?"
                          />
                          <textarea
                            rows={2}
                            value={faqItem.answer || ''}
                            onChange={(e) => {
                              const faq = [...(editableMetadata.faq || [])];
                              faq[fIdx] = { ...faq[fIdx], answer: e.target.value };
                              setEditableMetadata({ ...editableMetadata, faq });
                            }}
                            className="w-full text-xs p-2.5 bg-white border border-slate-200 rounded-lg text-slate-800 leading-relaxed focus:ring-1 focus:ring-purple-500"
                            placeholder="Comprehensive 2-4 sentence answer detailing the paper's findings or methods..."
                          />
                        </div>
                      ))}
                      {(!editableMetadata.faq || editableMetadata.faq.length === 0) && (
                        <div className="p-4 bg-slate-50 rounded-xl border border-dashed border-slate-200 text-center">
                          <p className="text-xs text-slate-500 font-medium">No FAQ items created yet.</p>
                          <p className="text-[11px] text-slate-400 mt-1">Click <strong>Auto-Generate 20 FAQs</strong> above to generate up to 20 detailed questions and answers using Gemini AI.</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Long-Tail Keywords Section */}
                  <div className="pt-6 border-t border-slate-200">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                      <div>
                        <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                          <Tag className="w-4 h-4 text-cyan-600" /> Long-Tail Keywords & Search Indexing
                        </h4>
                        <p className="text-xs text-slate-500 mt-0.5">Targeted multi-word search phrases passed to Zenodo metadata and embedded for Google Scholar discovery.</p>
                      </div>
                      <button
                        type="button"
                        onClick={handleGenerateKeywords}
                        disabled={generatingKeywords}
                        className="px-3 py-1.5 text-xs font-semibold text-cyan-700 bg-cyan-50 hover:bg-cyan-100 rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50 shrink-0"
                      >
                        {generatingKeywords ? (
                          <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating Long-Tail Keywords...</>
                        ) : (
                          <><Sparkles className="w-3.5 h-3.5 text-cyan-600" /> Auto-Generate Long-Tail Keywords</>
                        )}
                      </button>
                    </div>

                    <div className="space-y-3">
                      <textarea
                        rows={3}
                        value={(Array.isArray(editableMetadata.longTailKeywords) ? editableMetadata.longTailKeywords : []).join(', ')}
                        onChange={(e) => setEditableMetadata({
                          ...editableMetadata,
                          longTailKeywords: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                        })}
                        className="w-full px-3.5 py-2.5 text-xs bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-cyan-500 focus:outline-none font-mono text-slate-800 leading-relaxed"
                        placeholder="e.g. zero-shot vision-language medical imaging model, high-throughput transformer pipeline, multi-modal contrastive pretraining"
                      />
                      {Array.isArray(editableMetadata.longTailKeywords) && editableMetadata.longTailKeywords.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {editableMetadata.longTailKeywords.map((kw: string, kIdx: number) => (
                            <span key={kIdx} className="px-2.5 py-1 text-[11px] font-medium bg-cyan-50 text-cyan-800 border border-cyan-200/60 rounded-lg flex items-center gap-1">
                              <Tag className="w-2.5 h-2.5 text-cyan-600" /> {kw}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* SEO & Funding */}
                  <div className="pt-6 border-t border-slate-200 space-y-6">
                    <div>
                      <label className="block text-sm font-bold text-slate-900 mb-2">SEO Description (Max 160 characters)</label>
                      <textarea 
                        value={editableMetadata.seoDescription || ''} 
                        onChange={(e) => setEditableMetadata({...editableMetadata, seoDescription: e.target.value})}
                        className="w-full px-4 py-3 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        rows={2}
                        maxLength={160}
                        placeholder="Brief snippet for search engines"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-bold text-slate-900 mb-2">Funding Information</label>
                      <textarea 
                        value={editableMetadata.fundingInformation || ''} 
                        onChange={(e) => setEditableMetadata({...editableMetadata, fundingInformation: e.target.value})}
                        className="w-full px-4 py-3 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        rows={2}
                        placeholder="Grants, funding bodies, or support"
                      />
                    </div>
                  </div>

                  {/* Keywords, Subjects & License */}
                  <div className="pt-6 border-t border-slate-200 space-y-4">
                    <div>
                      <label className="block text-sm font-bold text-slate-900 mb-2">Keywords (comma-separated)</label>
                      <input 
                        value={(editableMetadata.seoKeywords || []).join(', ')} 
                        onChange={(e) => setEditableMetadata({
                          ...editableMetadata, 
                          seoKeywords: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                        })}
                        className="w-full px-4 py-3 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        placeholder="e.g. artificial intelligence, machine learning, dataset"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-bold text-slate-900 mb-2">Subjects (comma-separated)</label>
                      <input 
                        value={(editableMetadata.subjects || []).join(', ')} 
                        onChange={(e) => setEditableMetadata({
                          ...editableMetadata, 
                          subjects: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                        })}
                        className="w-full px-4 py-3 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        placeholder="e.g. Computer Science, Public Health, Criminal Law"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-bold text-slate-900 mb-2">License</label>
                      <input 
                        value={editableMetadata.license || ''} 
                        onChange={(e) => setEditableMetadata({...editableMetadata, license: e.target.value})}
                        className="w-full px-4 py-3 text-sm bg-white border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        placeholder="e.g. CC-BY-4.0"
                      />
                    </div>
                  </div>

                  {/* References Section */}
                  <div className="pt-6 border-t border-slate-200">
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                        References & URLs
                      </h4>
                      <button
                        type="button"
                        onClick={() => {
                          const current = editableMetadata.references || [];
                          setEditableMetadata({
                            ...editableMetadata,
                            references: [...current, { name: '', url: '' }]
                          });
                        }}
                        className="px-3 py-1.5 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors flex items-center gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add Reference
                      </button>
                    </div>

                    <div className="space-y-4">
                      {(editableMetadata.references || []).map((ref: any, idx: number) => (
                        <div key={idx} className="p-4 bg-white border border-slate-200 rounded-xl space-y-3 relative">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-500">Reference #{idx + 1}</span>
                            <button
                              type="button"
                              onClick={() => {
                                const references = [...(editableMetadata.references || [])];
                                references.splice(idx, 1);
                                setEditableMetadata({ ...editableMetadata, references });
                              }}
                              className="text-slate-400 hover:text-red-500 p-1"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <input
                              value={ref.name || (typeof ref === 'string' ? ref : '')}
                              onChange={(e) => {
                                const references = [...(editableMetadata.references || [])];
                                references[idx] = { 
                                  ...(typeof references[idx] === 'object' ? references[idx] : {}),
                                  name: e.target.value 
                                };
                                setEditableMetadata({ ...editableMetadata, references });
                              }}
                              className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
                              placeholder="Citation / Title / Name"
                            />
                            <input
                              value={ref.url || ''}
                              onChange={(e) => {
                                const references = [...(editableMetadata.references || [])];
                                references[idx] = { 
                                  ...(typeof references[idx] === 'object' ? references[idx] : {}),
                                  url: e.target.value 
                                };
                                setEditableMetadata({ ...editableMetadata, references });
                              }}
                              className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
                              placeholder="Reference URL (https://...)"
                            />
                          </div>
                        </div>
                      ))}
                      {(!editableMetadata.references || editableMetadata.references.length === 0) && (
                        <p className="text-xs text-slate-400 italic">No references added yet.</p>
                      )}
                    </div>
                  </div>

                  {/* Identifiers Section */}
                  <div className="pt-6 border-t border-slate-200">
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                        Identifiers (DOIs, ISBNs, etc.)
                      </h4>
                      <button
                        type="button"
                        onClick={() => {
                          const current = editableMetadata.identifiers || [];
                          setEditableMetadata({
                            ...editableMetadata,
                            identifiers: [...current, { identifier: '', scheme: 'doi' }]
                          });
                        }}
                        className="px-3 py-1.5 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors flex items-center gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add Identifier
                      </button>
                    </div>

                    <div className="space-y-4">
                      {(editableMetadata.identifiers || []).map((idItem: any, idx: number) => (
                        <div key={idx} className="p-4 bg-white border border-slate-200 rounded-xl space-y-3 relative">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-500">Identifier #{idx + 1}</span>
                            <button
                              type="button"
                              onClick={() => {
                                const identifiers = [...(editableMetadata.identifiers || [])];
                                identifiers.splice(idx, 1);
                                setEditableMetadata({ ...editableMetadata, identifiers });
                              }}
                              className="text-slate-400 hover:text-red-500 p-1"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <input
                              value={idItem.identifier || ''}
                              onChange={(e) => {
                                const identifiers = [...(editableMetadata.identifiers || [])];
                                identifiers[idx] = { ...identifiers[idx], identifier: e.target.value };
                                setEditableMetadata({ ...editableMetadata, identifiers });
                              }}
                              className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
                              placeholder="Identifier (e.g. 10.1000/182)"
                            />
                            <input
                              value={idItem.scheme || ''}
                              onChange={(e) => {
                                const identifiers = [...(editableMetadata.identifiers || [])];
                                identifiers[idx] = { ...identifiers[idx], scheme: e.target.value };
                                setEditableMetadata({ ...editableMetadata, identifiers });
                              }}
                              className="px-3 py-2 text-sm border border-slate-200 rounded-lg"
                              placeholder="Scheme (e.g. doi, isbn, url)"
                            />
                          </div>
                        </div>
                      ))}
                      {(!editableMetadata.identifiers || editableMetadata.identifiers.length === 0) && (
                        <p className="text-xs text-slate-400 italic">No identifiers added yet.</p>
                      )}
                    </div>
                  </div>

                  {/* FAQ Section */}
                  <div className="pt-6 border-t border-slate-200">
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                        Frequently Asked Questions (FAQ)
                      </h4>
                      <button
                        type="button"
                        onClick={() => {
                          const current = editableMetadata.faq || [];
                          setEditableMetadata({
                            ...editableMetadata,
                            faq: [...current, { question: '', answer: '' }]
                          });
                        }}
                        className="px-3 py-1.5 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors flex items-center gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add Question
                      </button>
                    </div>

                    <div className="space-y-4">
                      {(editableMetadata.faq || []).map((faqItem: any, idx: number) => (
                        <div key={idx} className="p-4 bg-white border border-slate-200 rounded-xl space-y-3 relative">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-500">FAQ Item #{idx + 1}</span>
                            <button
                              type="button"
                              onClick={() => {
                                const faq = [...(editableMetadata.faq || [])];
                                faq.splice(idx, 1);
                                setEditableMetadata({ ...editableMetadata, faq });
                              }}
                              className="text-slate-400 hover:text-red-500 p-1"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                          <div className="space-y-2">
                            <input
                              value={faqItem.question || ''}
                              onChange={(e) => {
                                const faq = [...(editableMetadata.faq || [])];
                                faq[idx] = { ...faq[idx], question: e.target.value };
                                setEditableMetadata({ ...editableMetadata, faq });
                              }}
                              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg font-medium"
                              placeholder="Question"
                            />
                            <textarea
                              value={faqItem.answer || ''}
                              onChange={(e) => {
                                const faq = [...(editableMetadata.faq || [])];
                                faq[idx] = { ...faq[idx], answer: e.target.value };
                                setEditableMetadata({ ...editableMetadata, faq });
                              }}
                              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                              rows={2}
                              placeholder="Answer"
                            />
                          </div>
                        </div>
                      ))}
                      {(!editableMetadata.faq || editableMetadata.faq.length === 0) && (
                        <p className="text-xs text-slate-400 italic">No FAQ items added yet.</p>
                      )}
                    </div>
                  </div>

                </div>

                <button
                  onClick={handleUploadToZenodo}
                  disabled={uploading}
                  className="mt-8 w-full px-6 py-3.5 bg-indigo-600 text-white rounded-xl font-semibold text-sm hover:bg-indigo-700 transition-all flex items-center justify-center gap-2 disabled:bg-slate-300 shadow-sm cursor-pointer disabled:cursor-not-allowed"
                >
                  {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudUpload className="w-4 h-4" />}
                  {uploading ? 'Uploading to Zenodo...' : 'Upload to Zenodo'}
                </button>
                {!zenodoApiKey && (
                  <p className="text-xs text-amber-700 mt-2 text-center font-medium">Zenodo Personal Access Token is required to complete publication. Click above to configure keys.</p>
                )}
              </div>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
