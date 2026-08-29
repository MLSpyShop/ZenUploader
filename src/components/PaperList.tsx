import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { collection, getDocs, doc, setDoc, getDoc, deleteDoc } from 'firebase/firestore';
import { db, auth } from '../lib/db';
import { User } from 'firebase/auth';
import { 
  RefreshCw, FileText, Trash2, Edit3, Loader2, Check, AlertCircle, 
  Search, Calendar, Users, ShieldAlert, Sparkles, X, Code, FileCheck,
  ExternalLink, Copy, ChevronDown, ChevronUp, BookOpen, Globe, Tag,
  Award, FileCode2, ArrowUpRight, CheckCircle2, ShieldCheck, Layers, RotateCcw,
  ArrowUp, ArrowDown
} from 'lucide-react';

export interface PaperAuthor {
  name: string;
  affiliation?: string;
  orcid?: string;
  gnd?: string;
}

export interface PaperMetadata {
  title?: string;
  description?: string;
  publication_date?: string;
  publicationDate?: string;
  doi?: string;
  creators?: (PaperAuthor | string)[];
  authors?: (PaperAuthor | string)[];
  keywords?: string[];
  upload_type?: string;
  publication_type?: string;
  access_right?: string;
  license?: string;
  journal_title?: string;
  journal_volume?: string;
  journal_issue?: string;
  journal_pages?: string;
  conference_title?: string;
  notes?: string;
  [key: string]: any;
}

export interface Paper {
  id: string;
  title: string;
  metadata: PaperMetadata;
  status: 'uploaded' | 'processed' | 'draft' | 'published' | string;
  source: 'firestore' | 'zenodo' | 'local';
  createdAt: string;
  zenodoRecordId?: string;
  zenodoDoi?: string;
  zenodoUrl?: string;
  environment?: 'production' | 'sandbox';
  isDuplicate?: boolean;
  isOriginal?: boolean;
  originalPaperId?: string;
  originalCreatedAt?: string;
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
  };
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
    },
    operationType,
    path
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
}

export default function PaperList({ user, refreshTrigger }: { user: User | null; refreshTrigger?: number }) {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingDuplicates, setDeletingDuplicates] = useState(false);
  const [deletingPaperId, setDeletingPaperId] = useState<string | null>(null);
  const [zenodoApiKey, setZenodoApiKey] = useState<string>('');
  const [expandedPaperIds, setExpandedPaperIds] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Search & Filter States
  const [searchTerm, setSearchTerm] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'originals' | 'duplicates' | 'zenodo'>('all');
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'pub_newest' | 'pub_oldest' | 'title' | 'custom'>('newest');
  const [customOrder, setCustomOrder] = useState<string[]>([]);

  // Edit / Fix Modal States
  const [editingPaper, setEditingPaper] = useState<Paper | null>(null);
  const [editTab, setEditTab] = useState<'form' | 'json'>('form');
  const [savingFix, setSavingFix] = useState(false);
  const [rawJsonText, setRawJsonText] = useState('');
  const [rawJsonError, setRawJsonError] = useState<string | null>(null);

  // Delete Confirmation Modals
  const [paperToDelete, setPaperToDelete] = useState<Paper | null>(null);
  const [showDeleteDuplicatesModal, setShowDeleteDuplicatesModal] = useState(false);

  // Helper to show brief toast notification
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 3000);
  };

  const getCleanZenodoKey = useCallback(async (): Promise<string> => {
    let key = localStorage.getItem('zenodo_api_key') || '';
    if (user && user.uid) {
      try {
        const docRef = doc(db, 'users', user.uid, 'settings', 'zenodo');
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data.zenodoApiKey) key = data.zenodoApiKey;
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, `users/${user.uid}/settings/zenodo`);
      }
    }
    const sanitized = key.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    return sanitized.toLowerCase().startsWith('bearer ') ? sanitized.substring(7).trim() : sanitized;
  }, [user]);

  const loadZenodoApiKey = useCallback(async () => {
    const key = await getCleanZenodoKey();
    setZenodoApiKey(key);
    return key;
  }, [getCleanZenodoKey]);

  const fetchPapers = useCallback(async () => {
    setLoading(true);
    try {
      const activeZenodoKey = await loadZenodoApiKey();

      // 1. Get set of deleted paper IDs (tombstones)
      const deletedIds = new Set<string>();
      try {
        const localDeleted = JSON.parse(localStorage.getItem('zenuploader_deleted_papers') || '[]');
        if (Array.isArray(localDeleted)) {
          localDeleted.forEach(id => deletedIds.add(String(id)));
        }
      } catch (e) {}

      if (user && user.uid) {
        try {
          const deletedSnap = await getDocs(collection(db, `users/${user.uid}/deleted_papers`));
          deletedSnap.forEach((docSnap) => {
            deletedIds.add(docSnap.id);
          });
        } catch (dErr) {
          handleFirestoreError(dErr, OperationType.LIST, `users/${user.uid}/deleted_papers`);
        }
      }

      const papersMap = new Map<string, Paper>();
      const recordIdMap = new Map<string, string>();
      const titleMap = new Map<string, string>();

      const addOrMergePaper = (paper: Paper) => {
        const rawId = paper.id;
        const zId = paper.zenodoRecordId ? String(paper.zenodoRecordId) : null;
        const rawTitle = paper.title || paper.metadata?.title || 'Untitled Research Paper';
        const normKey = rawTitle.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
        const hasValidTitle = normKey.length > 5;

        let canonicalKey = rawId;
        if (zId && recordIdMap.has(zId)) {
          canonicalKey = recordIdMap.get(zId)!;
        } else if (hasValidTitle && titleMap.has(normKey)) {
          canonicalKey = titleMap.get(normKey)!;
        }

        if (papersMap.has(canonicalKey)) {
          const existing = papersMap.get(canonicalKey)!;
          existing.title = existing.title && existing.title !== 'Untitled Research Paper' ? existing.title : paper.title;
          existing.zenodoRecordId = existing.zenodoRecordId || zId;
          existing.zenodoDoi = existing.zenodoDoi || paper.zenodoDoi;
          existing.zenodoUrl = existing.zenodoUrl || paper.zenodoUrl;
          existing.status = existing.status === 'uploaded' || paper.status === 'uploaded' ? 'uploaded' : existing.status;
          if (paper.source === 'zenodo' || paper.source === 'firestore') {
            existing.source = paper.source;
          }
          if ((!existing.metadata || Object.keys(existing.metadata).length === 0) && paper.metadata && Object.keys(paper.metadata).length > 0) {
            existing.metadata = paper.metadata;
          }
        } else {
          papersMap.set(canonicalKey, { ...paper, id: canonicalKey, isOriginal: true, isDuplicate: false });
          if (zId) recordIdMap.set(zId, canonicalKey);
          if (hasValidTitle) titleMap.set(normKey, canonicalKey);
        }
      };

      // 2. Fetch from Firestore
      if (user && user.uid) {
        try {
          const colPath = `users/${user.uid}/uploads`;
          const querySnapshot = await getDocs(collection(db, colPath));
          querySnapshot.forEach((docSnap) => {
            const rawId = docSnap.id;
            if (!deletedIds.has(rawId)) {
              const data = docSnap.data();
              const pMeta = data.metadata || {};
              const title = data.title || pMeta.title || 'Untitled Research Paper';
              const depositionId = data.zenodoRecordId || (data.status === 'uploaded' && !rawId.startsWith('paper_') ? rawId : undefined);
              const doi = data.zenodoDoi || pMeta.doi;
              const env = data.environment || (doi?.includes('5072') ? 'sandbox' : 'production');
              const url = data.zenodoUrl || (depositionId ? `https://${env === 'sandbox' ? 'sandbox.' : ''}zenodo.org/deposit/${depositionId}` : undefined);

              addOrMergePaper({
                id: rawId,
                title,
                metadata: pMeta,
                status: data.status || 'uploaded',
                source: 'firestore',
                createdAt: data.createdAt || new Date().toISOString(),
                zenodoRecordId: depositionId,
                zenodoDoi: doi,
                zenodoUrl: url,
                environment: env,
                isOriginal: true,
                isDuplicate: false
              });
            }
          });
        } catch (fErr) {
          handleFirestoreError(fErr, OperationType.LIST, `users/${user.uid}/uploads`);
        }
      }

      // 3. Fetch from LocalStorage
      try {
        const localUploads = JSON.parse(localStorage.getItem('zenuploader_local_uploads') || '[]');
        if (Array.isArray(localUploads)) {
          localUploads.forEach((data: any) => {
            const localId = String(data.id || `local_${data.createdAt}`);
            if (!deletedIds.has(localId)) {
              const pMeta = data.metadata || {};
              const title = data.title || pMeta.title || 'Untitled Research Paper';
              const depositionId = data.zenodoRecordId || (data.status === 'uploaded' && !localId.startsWith('paper_') ? localId : undefined);
              const doi = data.zenodoDoi || pMeta.doi;
              const env = data.environment || (doi?.includes('5072') ? 'sandbox' : 'production');
              const url = data.zenodoUrl || (depositionId ? `https://${env === 'sandbox' ? 'sandbox.' : ''}zenodo.org/deposit/${depositionId}` : undefined);

              addOrMergePaper({
                id: localId,
                title,
                metadata: pMeta,
                status: data.status || 'uploaded',
                source: 'local',
                createdAt: data.createdAt || new Date().toISOString(),
                zenodoRecordId: depositionId,
                zenodoDoi: doi,
                zenodoUrl: url,
                environment: env,
                isOriginal: true,
                isDuplicate: false
              });
            }
          });
        }
      } catch (lErr) {
        console.warn('Failed to parse local uploads:', lErr);
      }

      // 4. Fetch live depositions from Zenodo via server endpoint
      if (activeZenodoKey) {
        try {
          const res = await fetch('/api/get-zenodo-papers?zenodoApiKey=' + encodeURIComponent(activeZenodoKey));
          if (res.ok) {
            const zenodoDepositions = await res.json();
            if (Array.isArray(zenodoDepositions)) {
              zenodoDepositions.forEach((dep: any) => {
                const zId = String(dep.id);
                if (!deletedIds.has(zId)) {
                  const title = dep.title || dep.metadata?.title || 'Untitled Deposition';
                  const doi = dep.doi || dep.metadata?.doi;
                  const env = dep.environment || (doi?.includes('5072') ? 'sandbox' : 'production');
                  const url = dep.links?.html || dep.links?.record_html || `https://${env === 'sandbox' ? 'sandbox.' : ''}zenodo.org/deposit/${zId}`;

                  addOrMergePaper({
                    id: zId,
                    title,
                    metadata: dep.metadata || {},
                    status: dep.submitted ? 'published' : 'draft',
                    source: 'zenodo',
                    createdAt: dep.created || dep.modified || new Date().toISOString(),
                    zenodoRecordId: zId,
                    zenodoDoi: doi,
                    zenodoUrl: url,
                    environment: env,
                    isOriginal: true,
                    isDuplicate: false
                  });
                }
              });
            }
          }
        } catch (zErr) {
          console.warn('Live Zenodo depositions fetch error:', zErr);
        }
      }

      const paperList: Paper[] = Array.from(papersMap.values());

      // 6. Load custom order
      try {
        const localOrder = JSON.parse(localStorage.getItem('zenuploader_custom_order') || '[]');
        if (Array.isArray(localOrder) && localOrder.length > 0) {
          setCustomOrder(localOrder);
        }
      } catch (e) {}

      if (user && user.uid) {
        try {
          const orderDoc = await getDoc(doc(db, 'users', user.uid, 'settings', 'custom_order'));
          if (orderDoc.exists()) {
            const data = orderDoc.data();
            if (Array.isArray(data.order)) {
              setCustomOrder(data.order);
            }
          }
        } catch (e) {}
      }

      setPapers(paperList);
    } catch (err) {
      console.error('Failed to load papers:', err);
    } finally {
      setLoading(false);
    }
  }, [loadZenodoApiKey, user]);

  const saveCustomOrder = async (newOrder: string[]) => {
    setCustomOrder(newOrder);
    try {
      localStorage.setItem('zenuploader_custom_order', JSON.stringify(newOrder));
      if (user && user.uid) {
        await setDoc(doc(db, 'users', user.uid, 'settings', 'custom_order'), {
          order: newOrder,
          updatedAt: new Date().toISOString()
        }, { merge: true });
      }
    } catch (e) {
      console.warn('Failed to save order:', e);
    }
  };

  const handleMovePaperUp = (paperId: string) => {
    const currentList = [...filteredAndSortedPapers];
    const idx = currentList.findIndex(p => p.id === paperId);
    if (idx <= 0) return;
    const temp = currentList[idx];
    currentList[idx] = currentList[idx - 1];
    currentList[idx - 1] = temp;
    const newOrder = currentList.map(p => p.id);
    setSortBy('custom');
    saveCustomOrder(newOrder);
    showToast(`Moved "${(temp.title || 'Paper').substring(0, 24)}..." up to #${idx}`);
  };

  const handleMovePaperDown = (paperId: string) => {
    const currentList = [...filteredAndSortedPapers];
    const idx = currentList.findIndex(p => p.id === paperId);
    if (idx < 0 || idx >= currentList.length - 1) return;
    const temp = currentList[idx];
    currentList[idx] = currentList[idx + 1];
    currentList[idx + 1] = temp;
    const newOrder = currentList.map(p => p.id);
    setSortBy('custom');
    saveCustomOrder(newOrder);
    showToast(`Moved "${(temp.title || 'Paper').substring(0, 24)}..." down to #${idx + 2}`);
  };

  const handleMovePaperToPosition = (paperId: string, targetPosition: number) => {
    const currentList = [...filteredAndSortedPapers];
    const currentIdx = currentList.findIndex(p => p.id === paperId);
    if (currentIdx < 0) return;
    const targetIdx = Math.max(0, Math.min(targetPosition - 1, currentList.length - 1));
    if (currentIdx === targetIdx) return;
    
    const [movedItem] = currentList.splice(currentIdx, 1);
    currentList.splice(targetIdx, 0, movedItem);
    const newOrder = currentList.map(p => p.id);
    setSortBy('custom');
    saveCustomOrder(newOrder);
    showToast(`Moved "${(movedItem.title || 'Paper').substring(0, 24)}..." to #${targetIdx + 1}`);
  };

  const handleMoveToTop = (paperId: string) => {
    handleMovePaperToPosition(paperId, 1);
  };

  const handleMoveToBottom = (paperId: string) => {
    handleMovePaperToPosition(paperId, filteredAndSortedPapers.length);
  };

  const handleResetOrder = () => {
    saveCustomOrder([]);
    setSortBy('newest');
    showToast('Reset list to chronological order (Newest first)');
  };

  const handleLoadPaperToUploader = (paper: Paper) => {
    window.dispatchEvent(new CustomEvent('zenuploader_load_paper', {
      detail: {
        metadata: paper.metadata || paper
      }
    }));
    showToast(`Loaded "${(paper.title || 'Paper').substring(0, 28)}..." into uploader`);
  };

  useEffect(() => {
    fetchPapers();

    const handleRefresh = () => {
      fetchPapers();
    };

    window.addEventListener('zenuploader_refresh', handleRefresh);
    window.addEventListener('storage', handleRefresh);

    return () => {
      window.removeEventListener('zenuploader_refresh', handleRefresh);
      window.removeEventListener('storage', handleRefresh);
    };
  }, [fetchPapers, refreshTrigger]);

  const duplicatePapers = useMemo(() => papers.filter(p => p.isDuplicate), [papers]);

  const toggleExpand = (id: string) => {
    setExpandedPaperIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const copyToClipboard = async (text: string, keyName: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(keyName);
      showToast(`Copied ${label} to clipboard!`);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch (err) {
      showToast('Failed to copy text.');
    }
  };

  const generateCitation = (paper: Paper, format: 'bibtex' | 'apa'): string => {
    const title = paper.title || paper.metadata?.title || 'Untitled Research Paper';
    const authors = (paper.metadata?.creators || paper.metadata?.authors || [])
      .map((c: any) => (typeof c === 'string' ? c : c.name || 'Author'))
      .filter(Boolean);
    const authorStr = authors.length > 0 ? authors.join(' and ') : 'Anonymous';
    const date = paper.metadata?.publication_date || paper.metadata?.publicationDate || paper.createdAt.substring(0, 10);
    const year = date.substring(0, 4) || new Date().getFullYear().toString();
    const doi = paper.zenodoDoi || paper.metadata?.doi || '';
    const cleanId = paper.id.replace(/[^a-zA-Z0-9]/g, '_');

    if (format === 'bibtex') {
      return `@article{${cleanId}_${year},
  title={${title}},
  author={${authorStr}},
  year={${year}},
  month={${date.substring(5, 7) || '1'}},
  publisher={Zenodo},
  doi={${doi || 'https://doi.org/' + (paper.zenodoRecordId || paper.id)}}
}`;
    } else {
      const formattedAuthors = authors.length > 0 ? authors.join(', ') : 'Anonymous';
      return `${formattedAuthors} (${year}). ${title}. Zenodo. ${doi ? 'https://doi.org/' + doi : (paper.zenodoUrl || '')}`;
    }
  };

  const executeDeletePaper = async (paper: Paper) => {
    setPaperToDelete(null);
    setDeletingPaperId(paper.id);
    const safeId = String(paper.id).replace(/[^a-zA-Z0-9_-]/g, '_');

    // Optimistic UI update
    setPapers(prev => prev.filter(p => p.id !== paper.id));

    try {
      // 1. Record in local storage deleted tombstones and remove from local storage uploads
      try {
        const localDeleted = JSON.parse(localStorage.getItem('zenuploader_deleted_papers') || '[]');
        if (!localDeleted.includes(safeId)) localDeleted.push(safeId);
        if (!localDeleted.includes(String(paper.id))) localDeleted.push(String(paper.id));
        localStorage.setItem('zenuploader_deleted_papers', JSON.stringify(localDeleted));

        const localUploads = JSON.parse(localStorage.getItem('zenuploader_local_uploads') || '[]');
        if (Array.isArray(localUploads)) {
          const filteredLocal = localUploads.filter((item: any) => {
            const itemId = String(item.id || `local_${item.createdAt}`);
            return itemId !== paper.id && itemId !== safeId;
          });
          localStorage.setItem('zenuploader_local_uploads', JSON.stringify(filteredLocal));
        }
      } catch (e) {
        console.warn('Failed to update local storage during paper delete:', e);
      }

      // 2. Record in Firestore if authenticated
      if (user && user.uid) {
        try {
          await setDoc(doc(db, 'users', user.uid, 'deleted_papers', safeId), {
            deletedAt: new Date().toISOString(),
            title: paper.title || ''
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/deleted_papers/${safeId}`);
        }

        try {
          await deleteDoc(doc(db, 'users', user.uid, 'uploads', safeId));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/uploads/${safeId}`);
        }
      }

      // 3. Delete from Zenodo if deposition key present
      const cleanKey = await getCleanZenodoKey();
      if (cleanKey && paper.id) {
        try {
          await fetch('/api/delete-zenodo-paper', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ depositionId: paper.id, zenodoApiKey: cleanKey })
          });
        } catch (err) {
          console.warn('Zenodo delete notice:', err);
        }
      }

      showToast(`Deleted "${paper.title.substring(0, 30)}..."`);
      try {
        window.dispatchEvent(new CustomEvent('zenuploader_clear_document'));
      } catch (e) {}
      await fetchPapers();
    } catch (err) {
      console.error('Failed to delete paper:', err);
      showToast('Error deleting paper. Please try again.');
    } finally {
      setDeletingPaperId(null);
    }
  };

  const executeDeleteAllDuplicates = async () => {
    if (duplicatePapers.length === 0) return;
    
    setShowDeleteDuplicatesModal(false);
    setDeletingDuplicates(true);
    const idsToDelete = duplicatePapers.map(p => p.id);

    // Optimistic UI removal
    setPapers(prev => prev.filter(p => !idsToDelete.includes(p.id)));

    try {
      // 1. LocalStorage updates
      try {
        const localDeleted = JSON.parse(localStorage.getItem('zenuploader_deleted_papers') || '[]');
        idsToDelete.forEach(id => {
          const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
          if (!localDeleted.includes(safeId)) localDeleted.push(safeId);
          if (!localDeleted.includes(String(id))) localDeleted.push(String(id));
        });
        localStorage.setItem('zenuploader_deleted_papers', JSON.stringify(localDeleted));

        const localUploads = JSON.parse(localStorage.getItem('zenuploader_local_uploads') || '[]');
        if (Array.isArray(localUploads)) {
          const filteredLocal = localUploads.filter((item: any) => {
            const itemId = String(item.id || `local_${item.createdAt}`);
            return !idsToDelete.includes(itemId) && !idsToDelete.includes(String(itemId));
          });
          localStorage.setItem('zenuploader_local_uploads', JSON.stringify(filteredLocal));
        }
      } catch (e) {
        console.warn('Failed to update local storage during batch delete:', e);
      }

      const cleanKey = await getCleanZenodoKey();

      // 2. Iterate each duplicate
      for (const paper of duplicatePapers) {
        const safeId = String(paper.id).replace(/[^a-zA-Z0-9_-]/g, '_');
        
        if (user && user.uid) {
          try {
            await setDoc(doc(db, 'users', user.uid, 'deleted_papers', safeId), {
              deletedAt: new Date().toISOString(),
              title: paper.title || ''
            });
            await deleteDoc(doc(db, 'users', user.uid, 'uploads', safeId));
          } catch (err) {
            handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/deleted_papers/${safeId}`);
          }
        }

        if (cleanKey) {
          try {
            await fetch('/api/delete-zenodo-paper', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ depositionId: paper.id, zenodoApiKey: cleanKey })
            });
          } catch (err) {}
        }
      }

      showToast(`Successfully deleted ${duplicatePapers.length} duplicate paper(s)!`);
      await fetchPapers();
    } catch (err) {
      console.error('Failed to delete duplicates:', err);
      showToast('Error deleting duplicates.');
    } finally {
      setDeletingDuplicates(false);
    }
  };

  const handleOpenFixModal = (paper: Paper) => {
    setEditingPaper(JSON.parse(JSON.stringify(paper)));
    setRawJsonText(JSON.stringify(paper.metadata || {}, null, 2));
    setRawJsonError(null);
    setEditTab('form');
  };

  const handleSaveFix = async () => {
    if (!editingPaper) return;
    setSavingFix(true);
    setRawJsonError(null);

    try {
      let finalMetadata: PaperMetadata = editingPaper.metadata || {};

      if (editTab === 'json') {
        try {
          finalMetadata = JSON.parse(rawJsonText);
        } catch (e: any) {
          setRawJsonError('Invalid JSON format: ' + e.message);
          setSavingFix(false);
          return;
        }
      }

      const updatedTitle = (editingPaper.title || finalMetadata.title || 'Untitled Research Paper').trim();
      finalMetadata.title = updatedTitle;
      const safePaperId = String(editingPaper.id).replace(/[^a-zA-Z0-9_-]/g, '_');

      // 1. Update localStorage
      try {
        const localUploads = JSON.parse(localStorage.getItem('zenuploader_local_uploads') || '[]');
        if (Array.isArray(localUploads)) {
          const updatedLocal = localUploads.map((item: any) => {
            const itemId = String(item.id || `local_${item.createdAt}`);
            if (itemId === editingPaper.id || itemId === safePaperId) {
              return {
                ...item,
                title: updatedTitle,
                metadata: finalMetadata
              };
            }
            return item;
          });
          localStorage.setItem('zenuploader_local_uploads', JSON.stringify(updatedLocal));
        }
      } catch (e) {
        console.warn('Failed to update local storage during fix:', e);
      }

      // 2. Update Firestore
      if (user && user.uid) {
        try {
          const paperRef = doc(db, 'users', user.uid, 'uploads', safePaperId);
          await setDoc(paperRef, {
            title: updatedTitle,
            metadata: finalMetadata
          }, { merge: true });
        } catch (fErr) {
          handleFirestoreError(fErr, OperationType.UPDATE, `users/${user.uid}/uploads/${safePaperId}`);
        }
      }

      // 3. Update Zenodo deposition
      const cleanKey = await getCleanZenodoKey();
      if (cleanKey && editingPaper.id && !editingPaper.id.startsWith('paper_') && !editingPaper.id.startsWith('local_')) {
        try {
          const updateRes = await fetch('/api/update-zenodo-paper', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              depositionId: editingPaper.id,
              metadata: finalMetadata,
              zenodoApiKey: cleanKey
            })
          });

          if (!updateRes.ok) {
            const errBody = await updateRes.text();
            console.warn('Zenodo update server notice:', errBody);
          }
        } catch (zErr) {
          console.warn('Zenodo update network error:', zErr);
        }
      }

      setEditingPaper(null);
      showToast('Paper metadata saved successfully!');
      await fetchPapers();
    } catch (err: any) {
      console.error('Failed to save paper metadata:', err);
      showToast('Error saving metadata.');
    } finally {
      setSavingFix(false);
    }
  };

  // Filter & Sort papers
  const filteredAndSortedPapers = useMemo(() => {
    let result = papers.filter(p => {
      if (filterMode === 'originals' && p.isDuplicate) return false;
      if (filterMode === 'duplicates' && !p.isDuplicate) return false;
      if (filterMode === 'zenodo' && !p.zenodoRecordId && !p.zenodoDoi && p.source !== 'zenodo') return false;

      if (searchTerm.trim()) {
        const term = searchTerm.toLowerCase();
        const matchTitle = (p.title || '').toLowerCase().includes(term);
        const matchDesc = (p.metadata?.description || '').toLowerCase().includes(term);
        const matchCreators = JSON.stringify(p.metadata?.creators || p.metadata?.authors || []).toLowerCase().includes(term);
        const matchDoi = (p.zenodoDoi || p.metadata?.doi || '').toLowerCase().includes(term);
        const matchId = String(p.id).toLowerCase().includes(term);
        const matchKeywords = (p.metadata?.keywords || []).join(' ').toLowerCase().includes(term);
        return matchTitle || matchDesc || matchCreators || matchDoi || matchId || matchKeywords;
      }
      return true;
    });

    result.sort((a, b) => {
      const getUploadTime = (paper: Paper) => {
        if (paper.createdAt) {
          const t = new Date(paper.createdAt).getTime();
          if (!isNaN(t) && t > 0) return t;
        }
        const pDate = paper.metadata?.publication_date || paper.metadata?.publicationDate;
        if (pDate) {
          const t = new Date(pDate).getTime();
          if (!isNaN(t) && t > 0) return t;
        }
        return 0;
      };

      const getPubTime = (paper: Paper) => {
        const pDate = paper.metadata?.publication_date || paper.metadata?.publicationDate;
        if (pDate) {
          const t = new Date(pDate).getTime();
          if (!isNaN(t) && t > 0) return t;
        }
        return getUploadTime(paper);
      };

      if (sortBy === 'newest') {
        return getUploadTime(b) - getUploadTime(a);
      } else if (sortBy === 'oldest') {
        return getUploadTime(a) - getUploadTime(b);
      } else if (sortBy === 'pub_newest') {
        return getPubTime(b) - getPubTime(a);
      } else if (sortBy === 'pub_oldest') {
        return getPubTime(a) - getPubTime(b);
      } else if (sortBy === 'title') {
        return (a.title || '').localeCompare(b.title || '');
      } else if (sortBy === 'custom') {
        const idxA = customOrder.indexOf(a.id);
        const idxB = customOrder.indexOf(b.id);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return getUploadTime(b) - getUploadTime(a);
      }
      return 0;
    });

    return result;
  }, [papers, filterMode, searchTerm, sortBy, customOrder]);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <section id="uploaded-papers-section" className="bg-white border border-slate-200/80 rounded-2xl shadow-xs p-6 md:p-8 mt-8 transition-all">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 bg-slate-900 text-white text-xs font-semibold px-4 py-2.5 rounded-xl shadow-xl z-50 flex items-center gap-2 border border-slate-700 animate-in fade-in slide-in-from-bottom-3 duration-200">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Section Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-4 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-2 bg-blue-50 text-blue-600 rounded-xl">
              <FileCheck className="w-5 h-5" />
            </div>
            <h2 className="text-xl font-bold text-slate-900 tracking-tight">
              Uploaded Papers & History
            </h2>
            <span className="text-xs font-bold px-2 py-0.5 bg-slate-100 text-slate-700 rounded-full">
              {papers.length}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Browse deposited manuscripts, manage duplicates, edit metadata, and export citations.
          </p>
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {duplicatePapers.length > 0 && (
            <button
              onClick={() => setShowDeleteDuplicatesModal(true)}
              disabled={deletingDuplicates}
              className="px-3.5 py-2 bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white font-semibold text-xs rounded-xl shadow-xs transition-all flex items-center gap-1.5 disabled:opacity-50"
              title="Batch remove duplicate uploads while preserving the original oldest copy"
            >
              {deletingDuplicates ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ShieldAlert className="w-3.5 h-3.5" />
              )}
              Delete All Duplicates ({duplicatePapers.length})
            </button>
          )}

          <button 
            onClick={fetchPapers} 
            disabled={loading}
            className="px-3 py-2 border border-slate-200 hover:bg-slate-50 active:bg-slate-100 text-slate-700 rounded-xl transition-all flex items-center gap-1.5 text-xs font-medium"
            title="Refresh list and fetch live Zenodo records"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-blue-600' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Search Bar, Filter Chips & Sort */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 mb-6">
        {/* Search Input */}
        <div className="relative flex-grow max-w-md">
          <Search className="w-4 h-4 absolute left-3.5 top-3 text-slate-400" />
          <input
            type="text"
            placeholder="Search by title, author, keyword, DOI, or deposition ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-8 py-2 bg-slate-50/70 border border-slate-200 rounded-xl text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
          />
          {searchTerm && (
            <button 
              onClick={() => setSearchTerm('')} 
              className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 p-0.5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Filter Chips & Sort Select */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl text-xs">
            <button
              onClick={() => setFilterMode('all')}
              className={`px-3 py-1 rounded-lg font-medium transition-all ${
                filterMode === 'all' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              All ({papers.length})
            </button>
            <button
              onClick={() => setFilterMode('originals')}
              className={`px-3 py-1 rounded-lg font-medium transition-all ${
                filterMode === 'originals' ? 'bg-white text-emerald-800 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Originals ({papers.filter(p => !p.isDuplicate).length})
            </button>
            {duplicatePapers.length > 0 && (
              <button
                onClick={() => setFilterMode('duplicates')}
                className={`px-3 py-1 rounded-lg font-medium transition-all ${
                  filterMode === 'duplicates' ? 'bg-white text-rose-700 shadow-xs' : 'text-rose-600 hover:text-rose-800'
                }`}
              >
                Duplicates ({duplicatePapers.length})
              </button>
            )}
            <button
              onClick={() => setFilterMode('zenodo')}
              className={`px-3 py-1 rounded-lg font-medium transition-all ${
                filterMode === 'zenodo' ? 'bg-white text-blue-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Live Zenodo ({papers.filter(p => p.zenodoRecordId || p.zenodoDoi || p.source === 'zenodo').length})
            </button>
          </div>

          {/* Sort Dropdown */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 font-medium hidden sm:inline">Sort:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="py-1.5 px-3 bg-white border border-slate-200 text-xs font-semibold text-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 shadow-2xs cursor-pointer"
            >
              <option value="newest">📅 Chronological (Newest First)</option>
              <option value="oldest">⏳ Chronological (Oldest First)</option>
              <option value="pub_newest">📰 Publication Date (Newest)</option>
              <option value="pub_oldest">📜 Publication Date (Oldest)</option>
              <option value="title">🔤 Title (A-Z)</option>
              {customOrder.length > 0 && (
                <option value="custom">📌 Custom Order</option>
              )}
            </select>

            {customOrder.length > 0 && (
              <button
                type="button"
                onClick={handleResetOrder}
                className="text-[11px] text-blue-600 hover:text-blue-800 font-medium underline decoration-blue-300 cursor-pointer"
                title="Reset manual adjustments and restore chronological order"
              >
                Reset to Chronological
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Duplicate Warning Callout */}
      {duplicatePapers.length > 0 && filterMode !== 'originals' && (
        <div className="mb-6 p-4 bg-rose-50/80 border border-rose-200 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-rose-900">
          <div className="flex items-start sm:items-center gap-2.5">
            <ShieldAlert className="w-5 h-5 text-rose-600 shrink-0 mt-0.5 sm:mt-0" />
            <div>
              <span className="font-semibold">Detected {duplicatePapers.length} duplicate upload(s).</span>
              <span className="text-rose-700 ml-1">
                The original upload for each paper is preserved. Click "Delete Duplicates" to keep your deposit catalog clean.
              </span>
            </div>
          </div>
          <button
            onClick={() => setShowDeleteDuplicatesModal(true)}
            disabled={deletingDuplicates}
            className="px-3 py-1.5 bg-rose-600 text-white font-semibold rounded-lg hover:bg-rose-700 active:bg-rose-800 transition-all shrink-0 self-start sm:self-center shadow-xs"
          >
            {deletingDuplicates ? 'Deleting...' : 'Delete Duplicates'}
          </button>
        </div>
      )}

      {/* Loading Skeleton */}
      {loading && papers.length === 0 ? (
        <div className="py-16 flex flex-col items-center justify-center gap-3 text-slate-400">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          <p className="text-xs font-medium text-slate-600">Retrieving deposited papers & records...</p>
        </div>
      ) : filteredAndSortedPapers.length === 0 ? (
        /* Empty State */
        <div className="py-14 text-center border-2 border-dashed border-slate-200 rounded-2xl p-6 bg-slate-50/40">
          <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-3">
            <BookOpen className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-bold text-slate-900 mb-1">
            {papers.length === 0 ? 'No papers uploaded yet' : 'No matching papers found'}
          </h3>
          <p className="text-xs text-slate-500 max-w-sm mx-auto mb-4">
            {papers.length === 0
              ? 'Drag & drop a research manuscript in the upload box above to extract metadata and publish directly to Zenodo.'
              : 'Try adjusting your search query or switching the filter mode.'}
          </p>
          {papers.length === 0 ? (
            <button
              onClick={scrollToTop}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-xs transition-all inline-flex items-center gap-1.5"
            >
              <FileText className="w-3.5 h-3.5" />
              Upload a Research Paper
            </button>
          ) : (
            <button
              onClick={() => { setSearchTerm(''); setFilterMode('all'); }}
              className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition-all"
            >
              Clear Filters
            </button>
          )}
        </div>
      ) : (
        /* Papers List */
        <div className="space-y-3.5">
          {filteredAndSortedPapers.map((paper, idx) => {
            const isDeletingThis = deletingPaperId === paper.id;
            const isExpanded = expandedPaperIds.has(paper.id);
            const creators = paper.metadata?.creators || paper.metadata?.authors || [];
            const keywords = paper.metadata?.keywords || [];
            const pubDate = paper.metadata?.publication_date || paper.metadata?.publicationDate;
            const doi = paper.zenodoDoi || paper.metadata?.doi;
            const description = paper.metadata?.description || '';

            return (
              <div 
                key={paper.id} 
                id={`paper-card-${paper.id}`}
                className={`border rounded-2xl transition-all duration-200 overflow-hidden ${
                  paper.isDuplicate 
                    ? 'border-rose-200 bg-rose-50/20 hover:border-rose-300' 
                    : 'border-slate-200 bg-white hover:border-slate-300 shadow-xs'
                }`}
              >
                {/* Main Card Summary Bar */}
                <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-start gap-3.5 min-w-0 flex-grow">
                    {/* Icon & Position / Order Controls */}
                    <div className="flex flex-col items-center gap-1.5 shrink-0">
                      <div className={`p-2.5 rounded-xl ${
                        paper.isDuplicate ? 'bg-rose-100 text-rose-600' : 'bg-blue-50 text-blue-600'
                      }`}>
                        <FileText className="w-5 h-5" />
                      </div>
                      
                      {/* Position Reordering Widget */}
                      <div className="flex flex-col items-center gap-1 bg-slate-50 border border-slate-200 rounded-lg p-1">
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] font-mono font-bold text-slate-700">
                            #{idx + 1}
                          </span>
                          <div className="flex items-center">
                            <button
                              type="button"
                              onClick={() => handleMovePaperUp(paper.id)}
                              disabled={idx === 0}
                              className="text-slate-400 hover:text-blue-600 disabled:opacity-20 disabled:hover:text-slate-400 transition-colors p-0.5"
                              title={idx === 0 ? 'Already at top position' : 'Move up one position'}
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleMovePaperDown(paper.id)}
                              disabled={idx === filteredAndSortedPapers.length - 1}
                              className="text-slate-400 hover:text-blue-600 disabled:opacity-20 disabled:hover:text-slate-400 transition-colors p-0.5"
                              title={idx === filteredAndSortedPapers.length - 1 ? 'Already at bottom position' : 'Move down one position'}
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                          </div>
                        </div>

                        {/* Move to Position Dropdown */}
                        {filteredAndSortedPapers.length > 1 && (
                          <select
                            value={idx + 1}
                            onChange={(e) => handleMovePaperToPosition(paper.id, parseInt(e.target.value, 10))}
                            className="text-[9px] font-medium bg-white border border-slate-200 rounded px-1 py-0.5 text-slate-600 cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500"
                            title="Jump paper directly to any position number"
                          >
                            {filteredAndSortedPapers.map((_, pIdx) => (
                              <option key={pIdx + 1} value={pIdx + 1}>
                                Pos #{pIdx + 1}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </div>

                    {/* Paper Info */}
                    <div className="min-w-0 flex-grow">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <h3 className="text-sm font-bold text-slate-900 truncate max-w-xl" title={paper.title}>
                          {paper.title}
                        </h3>

                        {/* Status Badges */}
                        {paper.isDuplicate ? (
                          <span className="text-[10px] uppercase tracking-wider font-bold bg-rose-100 text-rose-700 px-2 py-0.5 rounded-md flex items-center gap-1">
                            <AlertCircle className="w-3 h-3" /> Duplicate
                          </span>
                        ) : (
                          <span className="text-[10px] uppercase tracking-wider font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-md flex items-center gap-1">
                            <Check className="w-3 h-3" /> Original
                          </span>
                        )}

                        {paper.environment && (
                          <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-md ${
                            paper.environment === 'sandbox' ? 'bg-amber-100 text-amber-800' : 'bg-indigo-100 text-indigo-800'
                          }`}>
                            {paper.environment}
                          </span>
                        )}

                        <span className="text-[10px] font-medium bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md uppercase">
                          {paper.status || 'uploaded'}
                        </span>
                      </div>

                      {/* Authors, Date, DOI line */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-500">
                        {creators.length > 0 && (
                          <span className="flex items-center gap-1.5 text-slate-700 font-medium">
                            <Users className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span className="truncate max-w-xs">
                              {creators.map((c: any) => (typeof c === 'string' ? c : c.name || 'Author')).join(', ')}
                            </span>
                          </span>
                        )}

                        {pubDate && (
                          <span className="flex items-center gap-1">
                            <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            Published: {pubDate}
                          </span>
                        )}

                        <span className="text-slate-400">
                          Uploaded {new Date(paper.createdAt).toLocaleDateString()}
                        </span>

                        {doi && (
                          <a 
                            href={`https://doi.org/${doi}`} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-[11px] text-blue-600 hover:text-blue-800 hover:underline"
                          >
                            <Globe className="w-3 h-3 text-blue-500" />
                            DOI: {doi}
                            <ArrowUpRight className="w-3 h-3 opacity-70" />
                          </a>
                        )}
                      </div>

                      {/* Duplicate Origin Warning */}
                      {paper.isDuplicate && paper.originalCreatedAt && (
                        <div className="mt-1 text-[11px] text-rose-600 font-medium flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" />
                          <span>Original upload was created on {new Date(paper.originalCreatedAt).toLocaleString()}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Actions Right Side */}
                  <div className="flex flex-wrap items-center gap-1.5 self-end sm:self-center shrink-0">
                    {/* Load into Uploader */}
                    <button
                      type="button"
                      onClick={() => handleLoadPaperToUploader(paper)}
                      className="px-2.5 py-1.5 text-xs font-semibold text-indigo-700 hover:text-indigo-900 bg-indigo-50 hover:bg-indigo-100/80 border border-indigo-200/60 rounded-xl transition-all flex items-center gap-1 cursor-pointer shadow-2xs"
                      title="Load paper metadata into the uploader workspace"
                    >
                      <Layers className="w-3.5 h-3.5 text-indigo-600" />
                      <span className="hidden md:inline">Load to Uploader</span>
                    </button>

                    {/* View on Zenodo button */}
                    {paper.zenodoUrl && (
                      <a
                        href={paper.zenodoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-xl transition-all flex items-center gap-1"
                        title="Open deposition directly on Zenodo"
                      >
                        <ExternalLink className="w-3.5 h-3.5 text-slate-500" />
                        <span className="hidden md:inline">Zenodo</span>
                      </a>
                    )}

                    {/* Expand Details Toggle */}
                    <button
                      onClick={() => toggleExpand(paper.id)}
                      className="px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all flex items-center gap-1"
                      title={isExpanded ? 'Collapse details' : 'Expand full metadata & citation'}
                    >
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      <span className="text-[11px]">{isExpanded ? 'Less' : 'Details'}</span>
                    </button>

                    {/* Fix Metadata */}
                    <button 
                      onClick={() => handleOpenFixModal(paper)}
                      className="px-3 py-1.5 text-xs font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100/80 rounded-xl transition-all flex items-center gap-1"
                      title="Edit title, authors, or raw metadata JSON"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>Edit</span>
                    </button>

                    {/* Delete button */}
                    <button 
                      onClick={() => setPaperToDelete(paper)}
                      disabled={isDeletingThis}
                      className="px-3 py-1.5 text-xs font-semibold text-rose-600 hover:text-rose-800 bg-rose-50 hover:bg-rose-100/80 rounded-xl transition-all flex items-center gap-1 disabled:opacity-50 cursor-pointer"
                      title={paper.isDuplicate ? 'Delete duplicate upload' : 'Delete paper from history'}
                    >
                      {isDeletingThis ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                      <span>{paper.isDuplicate ? 'Delete Copy' : 'Delete'}</span>
                    </button>
                  </div>
                </div>

                {/* Expanded Accordion Details Panel */}
                {isExpanded && (
                  <div className="px-5 pb-5 pt-2 border-t border-slate-100 bg-slate-50/50 space-y-4 text-xs">
                    {/* Abstract / Description */}
                    {description && (
                      <div>
                        <h4 className="font-semibold text-slate-700 mb-1 flex items-center gap-1.5">
                          <BookOpen className="w-3.5 h-3.5 text-slate-500" />
                          Abstract & Summary
                        </h4>
                        <div 
                          className="p-3 bg-white border border-slate-200/80 rounded-xl text-slate-700 text-xs leading-relaxed max-h-48 overflow-y-auto whitespace-pre-line"
                        >
                          {description.replace(/<[^>]*>?/gm, '')}
                        </div>
                      </div>
                    )}

                    {/* Authors and Affiliations */}
                    {creators.length > 0 && (
                      <div>
                        <h4 className="font-semibold text-slate-700 mb-1 flex items-center gap-1.5">
                          <Users className="w-3.5 h-3.5 text-slate-500" />
                          Authors & Affiliations
                        </h4>
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                          {creators.map((c: any, i: number) => {
                            const name = typeof c === 'string' ? c : c.name;
                            const aff = typeof c === 'object' ? c.affiliation : null;
                            const orcid = typeof c === 'object' ? c.orcid : null;
                            return (
                              <div key={i} className="p-2.5 bg-white border border-slate-200 rounded-xl">
                                <p className="font-semibold text-slate-800">{name}</p>
                                {aff && <p className="text-[11px] text-slate-500 truncate">{aff}</p>}
                                {orcid && (
                                  <a 
                                    href={`https://orcid.org/${orcid}`} 
                                    target="_blank" 
                                    rel="noreferrer"
                                    className="text-[10px] text-emerald-700 font-mono flex items-center gap-0.5 mt-0.5 hover:underline"
                                  >
                                    ORCID: {orcid}
                                  </a>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Keywords */}
                    {keywords.length > 0 && (
                      <div>
                        <h4 className="font-semibold text-slate-700 mb-1 flex items-center gap-1.5">
                          <Tag className="w-3.5 h-3.5 text-slate-500" />
                          Keywords & Topics
                        </h4>
                        <div className="flex flex-wrap gap-1.5">
                          {keywords.map((kw: string, ki: number) => (
                            <span key={ki} className="px-2.5 py-1 bg-white border border-slate-200 text-slate-700 text-[11px] rounded-lg font-medium">
                              {kw}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Citation & Export Bar */}
                    <div className="pt-2 border-t border-slate-200/60 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] font-semibold text-slate-600">Export Citation:</span>
                        <button
                          onClick={() => copyToClipboard(generateCitation(paper, 'bibtex'), `bib_${paper.id}`, 'BibTeX')}
                          className="px-2.5 py-1 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg text-[11px] font-medium text-slate-700 transition-all flex items-center gap-1"
                        >
                          <FileCode2 className="w-3 h-3 text-slate-500" />
                          {copiedKey === `bib_${paper.id}` ? 'Copied!' : 'BibTeX'}
                        </button>
                        <button
                          onClick={() => copyToClipboard(generateCitation(paper, 'apa'), `apa_${paper.id}`, 'APA')}
                          className="px-2.5 py-1 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg text-[11px] font-medium text-slate-700 transition-all flex items-center gap-1"
                        >
                          <Copy className="w-3 h-3 text-slate-500" />
                          {copiedKey === `apa_${paper.id}` ? 'Copied!' : 'APA'}
                        </button>
                        <button
                          onClick={() => copyToClipboard(JSON.stringify(paper.metadata, null, 2), `json_${paper.id}`, 'Metadata JSON')}
                          className="px-2.5 py-1 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg text-[11px] font-medium text-slate-700 transition-all flex items-center gap-1"
                        >
                          <Code className="w-3 h-3 text-slate-500" />
                          {copiedKey === `json_${paper.id}` ? 'Copied!' : 'JSON'}
                        </button>
                      </div>

                      <div className="text-[11px] text-slate-400 font-mono">
                        ID: {paper.id}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit / Fix Paper Modal */}
      {editingPaper && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-blue-100 text-blue-600 rounded-xl">
                  <Edit3 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">Edit Paper Metadata</h3>
                  <p className="text-xs text-slate-500">Update publication title, authors, abstract, and keywords</p>
                </div>
              </div>
              <button 
                onClick={() => setEditingPaper(null)} 
                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-200/50 transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Navigation Tabs */}
            <div className="flex border-b border-slate-200 px-5 pt-3 gap-4 bg-slate-50 text-xs font-semibold">
              <button
                onClick={() => setEditTab('form')}
                className={`pb-2.5 border-b-2 flex items-center gap-1.5 transition-all ${
                  editTab === 'form' 
                    ? 'border-blue-600 text-blue-600' 
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" /> Friendly Form
              </button>
              <button
                onClick={() => {
                  setEditTab('json');
                  setRawJsonText(JSON.stringify(editingPaper.metadata || {}, null, 2));
                  setRawJsonError(null);
                }}
                className={`pb-2.5 border-b-2 flex items-center gap-1.5 transition-all ${
                  editTab === 'json' 
                    ? 'border-blue-600 text-blue-600' 
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <Code className="w-3.5 h-3.5" /> Raw JSON Editor
              </button>
            </div>

            {/* Modal Content Body */}
            <div className="p-6 overflow-y-auto flex-grow space-y-4 text-xs">
              {editTab === 'form' ? (
                <>
                  {/* Title */}
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Manuscript Title</label>
                    <input
                      type="text"
                      value={editingPaper.title || ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        setEditingPaper({
                          ...editingPaper,
                          title: val,
                          metadata: { ...editingPaper.metadata, title: val }
                        });
                      }}
                      className="w-full p-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-xs font-medium text-slate-900"
                      placeholder="Enter research paper title..."
                    />
                  </div>

                  {/* Abstract / Description */}
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Abstract / Description</label>
                    <textarea
                      rows={4}
                      value={editingPaper.metadata?.description || ''}
                      onChange={(e) => {
                        setEditingPaper({
                          ...editingPaper,
                          metadata: { ...editingPaper.metadata, description: e.target.value }
                        });
                      }}
                      className="w-full p-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-xs text-slate-800"
                      placeholder="Enter paper abstract..."
                    />
                  </div>

                  {/* Publication Date & DOI */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Publication Date (YYYY-MM-DD)</label>
                      <input
                        type="text"
                        placeholder="e.g. 2026-08-28"
                        value={editingPaper.metadata?.publication_date || editingPaper.metadata?.publicationDate || ''}
                        onChange={(e) => {
                          setEditingPaper({
                            ...editingPaper,
                            metadata: { ...editingPaper.metadata, publication_date: e.target.value, publicationDate: e.target.value }
                          });
                        }}
                        className="w-full p-2 border border-slate-200 rounded-xl text-xs text-slate-800"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">DOI (optional)</label>
                      <input
                        type="text"
                        placeholder="10.5281/zenodo.12345"
                        value={editingPaper.metadata?.doi || editingPaper.zenodoDoi || ''}
                        onChange={(e) => {
                          setEditingPaper({
                            ...editingPaper,
                            zenodoDoi: e.target.value,
                            metadata: { ...editingPaper.metadata, doi: e.target.value }
                          });
                        }}
                        className="w-full p-2 border border-slate-200 rounded-xl text-xs text-slate-800"
                      />
                    </div>
                  </div>

                  {/* Authors / Creators */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="font-semibold text-slate-700">Authors / Creators</label>
                      <button
                        type="button"
                        onClick={() => {
                          const creators = [...(editingPaper.metadata?.creators || editingPaper.metadata?.authors || [])];
                          creators.push({ name: '', affiliation: '' });
                          setEditingPaper({
                            ...editingPaper,
                            metadata: { ...editingPaper.metadata, creators, authors: creators }
                          });
                        }}
                        className="text-[11px] text-blue-600 hover:text-blue-800 font-semibold flex items-center gap-1"
                      >
                        + Add Author
                      </button>
                    </div>

                    <div className="space-y-2">
                      {(editingPaper.metadata?.creators || editingPaper.metadata?.authors || []).map((creator: any, idx: number) => {
                        const name = typeof creator === 'string' ? creator : creator.name || '';
                        const affiliation = typeof creator === 'object' ? creator.affiliation || '' : '';

                        return (
                          <div key={idx} className="flex items-center gap-2 bg-slate-50 p-2 border border-slate-200 rounded-xl">
                            <input
                              type="text"
                              placeholder="Author Name (e.g. Marie Curie)"
                              value={name}
                              onChange={(e) => {
                                const creators = [...(editingPaper.metadata?.creators || editingPaper.metadata?.authors || [])];
                                creators[idx] = { name: e.target.value, affiliation };
                                setEditingPaper({
                                  ...editingPaper,
                                  metadata: { ...editingPaper.metadata, creators, authors: creators }
                                });
                              }}
                              className="w-1/2 p-1.5 border border-slate-200 rounded-lg text-xs bg-white text-slate-900"
                            />
                            <input
                              type="text"
                              placeholder="Affiliation / University"
                              value={affiliation}
                              onChange={(e) => {
                                const creators = [...(editingPaper.metadata?.creators || editingPaper.metadata?.authors || [])];
                                creators[idx] = { name, affiliation: e.target.value };
                                setEditingPaper({
                                  ...editingPaper,
                                  metadata: { ...editingPaper.metadata, creators, authors: creators }
                                });
                              }}
                              className="w-1/2 p-1.5 border border-slate-200 rounded-lg text-xs bg-white text-slate-900"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const creators = [...(editingPaper.metadata?.creators || editingPaper.metadata?.authors || [])];
                                creators.splice(idx, 1);
                                setEditingPaper({
                                  ...editingPaper,
                                  metadata: { ...editingPaper.metadata, creators, authors: creators }
                                });
                              }}
                              className="p-1 text-slate-400 hover:text-rose-600 rounded transition-all"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Keywords */}
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Keywords (comma-separated)</label>
                    <input
                      type="text"
                      placeholder="e.g. Artificial Intelligence, Data Mining, Quantum Mechanics"
                      value={Array.isArray(editingPaper.metadata?.keywords) ? editingPaper.metadata.keywords.join(', ') : ''}
                      onChange={(e) => {
                        const kwList = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                        setEditingPaper({
                          ...editingPaper,
                          metadata: { ...editingPaper.metadata, keywords: kwList }
                        });
                      }}
                      className="w-full p-2 border border-slate-200 rounded-xl text-xs text-slate-800"
                    />
                  </div>
                </>
              ) : (
                /* Raw JSON editor tab */
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="font-semibold text-slate-700">Metadata Payload (JSON)</label>
                    <button
                      onClick={() => {
                        try {
                          const formatted = JSON.stringify(JSON.parse(rawJsonText), null, 2);
                          setRawJsonText(formatted);
                          setRawJsonError(null);
                        } catch (e: any) {
                          setRawJsonError('JSON format error: ' + e.message);
                        }
                      }}
                      className="text-[11px] text-blue-600 hover:text-blue-800 font-semibold"
                    >
                      Format JSON
                    </button>
                  </div>
                  <textarea 
                    value={rawJsonText}
                    onChange={(e) => {
                      setRawJsonText(e.target.value);
                      setRawJsonError(null);
                    }}
                    className="w-full h-80 border border-slate-300 rounded-xl p-3 font-mono text-xs text-slate-100 bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {rawJsonError && (
                    <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-rose-600 text-xs flex items-center gap-1 font-medium">
                      <AlertCircle className="w-4 h-4 shrink-0" /> {rawJsonError}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-100 flex items-center justify-end gap-2 bg-slate-50">
              <button 
                onClick={() => setEditingPaper(null)} 
                className="px-4 py-2 border border-slate-200 hover:bg-slate-100 rounded-xl text-slate-700 text-xs font-semibold transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={handleSaveFix} 
                disabled={savingFix}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-xl text-xs font-semibold shadow-xs transition-all flex items-center gap-1.5 disabled:opacity-50"
              >
                {savingFix ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Single Paper Confirmation Modal */}
      {paperToDelete && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-rose-100 text-rose-600 rounded-full">
                <Trash2 className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {paperToDelete.isDuplicate ? 'Delete Duplicate Copy' : 'Delete Paper'}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">This action will remove the record.</p>
              </div>
            </div>

            <div className="text-xs text-slate-700 bg-slate-50 p-3 rounded-xl border border-slate-100 font-medium mb-6 space-y-1">
              <p>Are you sure you want to delete:</p>
              <p className="font-bold text-slate-900 truncate">"{paperToDelete.title}"</p>
              {paperToDelete.isDuplicate && (
                <p className="text-emerald-700 text-[11px] pt-1">
                  The original copy of this manuscript will remain safely in your history.
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setPaperToDelete(null)}
                className="px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={() => executeDeletePaper(paperToDelete)}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white text-xs font-semibold rounded-xl shadow-xs transition-all flex items-center gap-1.5"
              >
                <Trash2 className="w-4 h-4" />
                Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete All Duplicates Confirmation Modal */}
      {showDeleteDuplicatesModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-rose-100 text-rose-600 rounded-full">
                <ShieldCheck className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Delete All Duplicates</h3>
                <p className="text-xs text-slate-500 mt-0.5">Smart batch cleanup of redundant depositions</p>
              </div>
            </div>

            <div className="text-xs text-slate-700 bg-rose-50 border border-rose-100 p-3.5 rounded-xl mb-6 space-y-1.5">
              <p className="font-semibold text-rose-900">
                You are about to remove {duplicatePapers.length} duplicate upload(s).
              </p>
              <p className="text-rose-800">
                Only redundant secondary copies will be deleted. The original (oldest) version of every paper will be safely preserved.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowDeleteDuplicatesModal(false)}
                className="px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={executeDeleteAllDuplicates}
                disabled={deletingDuplicates}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white text-xs font-semibold rounded-xl shadow-xs transition-all flex items-center gap-1.5 disabled:opacity-50"
              >
                {deletingDuplicates ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Yes, Delete {duplicatePapers.length} Duplicates
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
