import React, { useState, useEffect } from 'react';
import { collection, query, getDocs, doc, setDoc, getDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../lib/db';
import { User } from 'firebase/auth';
import { 
  RefreshCw, FileText, Trash2, Edit3, Loader2, Check, AlertCircle, 
  Search, Filter, Calendar, Users, ShieldAlert, Sparkles, X, Code, FileCheck
} from 'lucide-react';

export interface Paper {
  id: string;
  title: string;
  metadata: any;
  status: string;
  source: 'firestore' | 'zenodo';
  createdAt: string;
  isDuplicate?: boolean;
  isOriginal?: boolean;
  originalPaperId?: string;
  originalCreatedAt?: string;
}

export default function PaperList({ user, refreshTrigger }: { user: User; refreshTrigger?: number }) {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingDuplicates, setDeletingDuplicates] = useState(false);
  const [deletingPaperId, setDeletingPaperId] = useState<string | null>(null);
  const [zenodoApiKey, setZenodoApiKey] = useState<string>('');
  
  // Modal & Search States
  const [editingPaper, setEditingPaper] = useState<Paper | null>(null);
  const [editTab, setEditTab] = useState<'form' | 'json'>('form');
  const [savingFix, setSavingFix] = useState(false);
  const [rawJsonText, setRawJsonText] = useState('');
  const [rawJsonError, setRawJsonError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'duplicates' | 'originals'>('all');

  // Delete confirmation modals state
  const [paperToDelete, setPaperToDelete] = useState<Paper | null>(null);
  const [showDeleteDuplicatesModal, setShowDeleteDuplicatesModal] = useState(false);

  useEffect(() => {
    loadZenodoApiKey();
  }, [user]);

  useEffect(() => {
    fetchPapers();
  }, [user, zenodoApiKey, refreshTrigger]);

  const loadZenodoApiKey = async () => {
    try {
      const docRef = doc(db, 'users', user.uid, 'settings', 'zenodo');
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const data = docSnap.data();
        setZenodoApiKey(data.zenodoApiKey || '');
      }
    } catch (err) {
      console.error('Failed to load API Keys:', err);
    }
  };

  const fetchPapers = async () => {
    setLoading(true);
    try {
      // 1. Get set of deleted paper IDs
      const deletedIds = new Set<string>();
      try {
        const deletedSnap = await getDocs(collection(db, `users/${user.uid}/deleted_papers`));
        deletedSnap.forEach((docSnap) => {
          deletedIds.add(docSnap.id);
        });
      } catch (dErr) {
        console.warn('Failed to fetch deleted_papers set:', dErr);
      }

      const papersData: Paper[] = [];
      
      // Fetch from Firestore
      const colPath = `users/${user.uid}/uploads`;
      const q = query(collection(db, colPath));
      const querySnapshot = await getDocs(q);
      querySnapshot.forEach((docSnap) => {
        if (!deletedIds.has(docSnap.id)) {
          const data = docSnap.data();
          papersData.push({ 
            id: docSnap.id, 
            title: data.title || data.metadata?.title || 'Untitled',
            metadata: data.metadata || {}, 
            status: data.status || 'uploaded', 
            source: 'firestore',
            createdAt: data.createdAt || new Date().toISOString() 
          });
        }
      });

      // Fetch from Zenodo
      const cleanZenodoKey = zenodoApiKey ? zenodoApiKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim() : '';
      if (cleanZenodoKey) {
        try {
          const response = await fetch('https://zenodo.org/api/deposit/depositions?access_token=' + encodeURIComponent(cleanZenodoKey) + '&size=100');
          if (response.ok) {
            const zenodoPapers = await response.json();
            if (Array.isArray(zenodoPapers)) {
              zenodoPapers.forEach((p: any) => {
                const zId = p.id.toString();
                if (!deletedIds.has(zId)) {
                  const existing = papersData.find(pd => pd.id === zId);
                  if (!existing) {
                    papersData.push({ 
                      id: zId, 
                      title: p.title || p.metadata?.title || 'Untitled', 
                      metadata: p.metadata || {}, 
                      status: p.submitted ? 'published' : 'draft', 
                      source: 'zenodo',
                      createdAt: p.created || new Date().toISOString()
                    });
                  }
                }
              });
            }
          }
        } catch (zErr) {
          console.warn('Failed to fetch Zenodo papers:', zErr);
        }
      }
      
      // Identify duplicates by grouping normalized title
      const titleGroups = new Map<string, Paper[]>();
      papersData.forEach(p => {
        const normTitle = (p.title || p.metadata?.title || 'Untitled').trim().toLowerCase();
        if (!titleGroups.has(normTitle)) {
          titleGroups.set(normTitle, []);
        }
        titleGroups.get(normTitle)!.push(p);
      });
      
      titleGroups.forEach((group) => {
        if (group.length > 1) {
          // Sort ascending by createdAt (oldest first)
          group.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          
          const oldest = group[0];
          oldest.isOriginal = true;
          oldest.isDuplicate = false;

          for (let i = 1; i < group.length; i++) {
            group[i].isDuplicate = true;
            group[i].isOriginal = false;
            group[i].originalPaperId = oldest.id;
            group[i].originalCreatedAt = oldest.createdAt;
          }
        } else if (group.length === 1) {
          group[0].isOriginal = true;
          group[0].isDuplicate = false;
        }
      });

      // Sort full list by createdAt descending for display
      papersData.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      
      setPapers(papersData);
    } catch (err) {
      console.error('Failed to fetch papers:', err);
    } finally {
      setLoading(false);
    }
  };

  const duplicatePapers = papers.filter(p => p.isDuplicate);

  const executeDeleteAllDuplicates = async () => {
    if (duplicatePapers.length === 0) return;
    
    setShowDeleteDuplicatesModal(false);
    setDeletingDuplicates(true);
    const cleanZenodoKey = zenodoApiKey ? zenodoApiKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim() : '';

    const idsToDelete = duplicatePapers.map(p => p.id);
    
    // Optimistic UI removal
    setPapers(prev => prev.filter(p => !idsToDelete.includes(p.id)));

    try {
      for (const paper of duplicatePapers) {
        const safeId = String(paper.id).replace(/[^a-zA-Z0-9_-]/g, '_');
        // Record as deleted so Zenodo API refetch ignores it
        try {
          await setDoc(doc(db, 'users', user.uid, 'deleted_papers', safeId), {
            deletedAt: new Date().toISOString(),
            title: paper.title || ''
          });
        } catch (err) {
          console.warn('Firestore set deleted_papers failed:', paper.id, err);
        }

        // Delete from Firestore uploads
        try {
          await deleteDoc(doc(db, 'users', user.uid, 'uploads', safeId));
        } catch (err) {
          console.warn('Firestore delete failed for duplicate:', paper.id, err);
        }

        // Delete from Zenodo if key present
        if (cleanZenodoKey) {
          try {
            const url = `https://zenodo.org/api/deposit/depositions/${paper.id}?access_token=${encodeURIComponent(cleanZenodoKey)}`;
            await fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
          } catch (err) {
            console.warn('Zenodo delete failed for duplicate:', paper.id, err);
          }
        }
      }
      await fetchPapers();
    } catch (err) {
      console.error('Failed to delete duplicates:', err);
    } finally {
      setDeletingDuplicates(false);
    }
  };

  const executeDeletePaper = async (paper: Paper) => {
    setPaperToDelete(null);
    setDeletingPaperId(paper.id);
    const cleanZenodoKey = zenodoApiKey ? zenodoApiKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim() : '';

    // Optimistic UI update
    setPapers(prev => prev.filter(p => p.id !== paper.id));

    try {
      const safeId = String(paper.id).replace(/[^a-zA-Z0-9_-]/g, '_');
      // 1. Record in deleted_papers collection
      try {
        await setDoc(doc(db, 'users', user.uid, 'deleted_papers', safeId), {
          deletedAt: new Date().toISOString(),
          title: paper.title || ''
        });
      } catch (err) {
        console.warn('Firestore deleted_papers write error:', err);
      }

      // 2. Delete from Firestore uploads
      try {
        await deleteDoc(doc(db, 'users', user.uid, 'uploads', safeId));
      } catch (err) {
        console.warn('Firestore delete error:', err);
      }

      // 3. Delete from Zenodo if present
      if (cleanZenodoKey) {
        try {
          const url = `https://zenodo.org/api/deposit/depositions/${paper.id}?access_token=${encodeURIComponent(cleanZenodoKey)}`;
          await fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
        } catch (err) {
          console.warn('Zenodo delete error:', err);
        }
      }

      await fetchPapers();
    } catch (err) {
      console.error('Failed to delete paper:', err);
    } finally {
      setDeletingPaperId(null);
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
    try {
      let finalMetadata = editingPaper.metadata || {};

      if (editTab === 'json') {
        try {
          finalMetadata = JSON.parse(rawJsonText);
        } catch (e: any) {
          setRawJsonError('Invalid JSON format: ' + e.message);
          setSavingFix(false);
          return;
        }
      }

      const updatedTitle = editingPaper.title || finalMetadata.title || 'Untitled';
      finalMetadata.title = updatedTitle;

      // Update Firestore
      const safePaperId = String(editingPaper.id).replace(/[^a-zA-Z0-9_-]/g, '_');
      const paperRef = doc(db, 'users', user.uid, 'uploads', safePaperId);
      await setDoc(paperRef, {
        title: updatedTitle,
        metadata: finalMetadata
      }, { merge: true });

      // Update Zenodo via server endpoint if key present
      const cleanZenodoKey = zenodoApiKey ? zenodoApiKey.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[^\x21-\x7E]/g, '').trim() : '';
      if (cleanZenodoKey) {
        try {
          await fetch('/api/update-zenodo-paper', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              depositionId: editingPaper.id,
              metadata: finalMetadata,
              zenodoApiKey: cleanZenodoKey
            })
          });
        } catch (zErr) {
          console.warn('Zenodo update failed:', zErr);
        }
      }

      setEditingPaper(null);
      await fetchPapers();
    } catch (err) {
      console.error('Failed to update paper:', err);
      alert('Failed to save paper metadata.');
    } finally {
      setSavingFix(false);
    }
  };

  // Filter papers for display
  const filteredPapers = papers.filter(p => {
    if (filterMode === 'duplicates' && !p.isDuplicate) return false;
    if (filterMode === 'originals' && p.isDuplicate) return false;
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      const matchTitle = (p.title || '').toLowerCase().includes(term);
      const matchDesc = (p.metadata?.description || '').toLowerCase().includes(term);
      const matchCreators = JSON.stringify(p.metadata?.creators || []).toLowerCase().includes(term);
      return matchTitle || matchDesc || matchCreators;
    }
    return true;
  });

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 mt-8">
      {/* Header Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-4 border-b border-slate-100">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <FileCheck className="w-6 h-6 text-blue-600" />
            Uploaded Papers ({papers.length})
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Manage your Zenodo depositions and extracted paper metadata.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {duplicatePapers.length > 0 && (
            <button
              onClick={() => setShowDeleteDuplicatesModal(true)}
              disabled={deletingDuplicates}
              className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white font-semibold text-xs rounded-xl shadow-sm transition-all flex items-center gap-2 disabled:opacity-50"
              title="Delete all duplicate uploads, keeping only the oldest copy of each"
            >
              {deletingDuplicates ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
              Delete All Duplicates ({duplicatePapers.length})
            </button>
          )}

          <button 
            onClick={fetchPapers} 
            disabled={loading}
            className="p-2 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl transition-all flex items-center gap-1.5 text-xs font-medium"
            title="Refresh list"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-blue-600' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mb-6">
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search papers or authors..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
          />
          {searchTerm && (
            <button 
              onClick={() => setSearchTerm('')} 
              className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-600"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl text-xs w-full sm:w-auto justify-center">
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
              filterMode === 'originals' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Originals ({papers.filter(p => !p.isDuplicate).length})
          </button>
          <button
            onClick={() => setFilterMode('duplicates')}
            className={`px-3 py-1 rounded-lg font-medium transition-all ${
              filterMode === 'duplicates' ? 'bg-white text-rose-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Duplicates ({duplicatePapers.length})
          </button>
        </div>
      </div>

      {/* Duplicate Summary Banner */}
      {duplicatePapers.length > 0 && filterMode !== 'originals' && (
        <div className="mb-6 p-4 bg-rose-50 border border-rose-200 rounded-xl flex items-center justify-between gap-3 text-xs text-rose-900">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0" />
            <span>
              Found <strong>{duplicatePapers.length} duplicate upload(s)</strong>. You can click <strong>Delete All Duplicates</strong> to keep only the oldest copy of each paper.
            </span>
          </div>
          <button
            onClick={() => setShowDeleteDuplicatesModal(true)}
            disabled={deletingDuplicates}
            className="px-3 py-1.5 bg-rose-600 text-white font-semibold rounded-lg hover:bg-rose-700 transition-all shrink-0"
          >
            {deletingDuplicates ? 'Deleting...' : 'Delete Duplicates'}
          </button>
        </div>
      )}

      {/* List Container */}
      {loading && papers.length === 0 ? (
        <div className="py-12 flex flex-col items-center justify-center gap-2 text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          <span className="text-xs">Loading papers...</span>
        </div>
      ) : filteredPapers.length === 0 ? (
        <div className="py-12 text-center text-slate-500 text-xs">
          {papers.length === 0 ? 'No papers uploaded yet.' : 'No papers match your search/filter.'}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredPapers.map((paper) => {
            const isDeletingThis = deletingPaperId === paper.id;
            const creators = paper.metadata?.creators || [];

            return (
              <div 
                key={paper.id} 
                id={paper.id} 
                className={`p-4 border rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-all ${
                  paper.isDuplicate 
                    ? 'border-rose-200 bg-rose-50/30 hover:border-rose-300' 
                    : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <div className="flex items-start gap-3 min-w-0 flex-grow">
                  <div className={`p-2 rounded-lg shrink-0 ${paper.isDuplicate ? 'bg-rose-100 text-rose-600' : 'bg-blue-50 text-blue-600'}`}>
                    <FileText className="w-5 h-5" />
                  </div>

                  <div className="min-w-0 flex-grow">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-slate-900 truncate max-w-md" title={paper.title}>
                        {paper.title}
                      </h3>

                      {paper.isDuplicate ? (
                        <span className="text-[10px] uppercase tracking-wider font-bold bg-rose-100 text-rose-700 px-2 py-0.5 rounded-md flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" /> Duplicate
                        </span>
                      ) : (
                        <span className="text-[10px] uppercase tracking-wider font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-md flex items-center gap-1">
                          <Check className="w-3 h-3" /> Original (Oldest)
                        </span>
                      )}

                      <span className="text-[10px] font-medium bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md uppercase">
                        {paper.source}
                      </span>
                    </div>

                    {/* Metadata details */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 mt-1">
                      {creators.length > 0 && (
                        <span className="flex items-center gap-1">
                          <Users className="w-3 h-3 text-slate-400" />
                          {creators.map((c: any) => c.name || c).join(', ')}
                        </span>
                      )}
                      
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3 text-slate-400" />
                        Uploaded {new Date(paper.createdAt).toLocaleDateString()}
                      </span>

                      {paper.isDuplicate && paper.originalCreatedAt && (
                        <span className="text-rose-600 font-medium">
                          Original was uploaded on {new Date(paper.originalCreatedAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                  <button 
                    onClick={() => handleOpenFixModal(paper)}
                    className="px-3 py-1.5 text-xs font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 rounded-lg transition-all flex items-center gap-1"
                  >
                    <Edit3 className="w-3.5 h-3.5" /> Fix Metadata
                  </button>

                  <button 
                    onClick={() => setPaperToDelete(paper)}
                    disabled={isDeletingThis}
                    className="px-3 py-1.5 text-xs font-semibold text-rose-600 hover:text-rose-800 bg-rose-50 hover:bg-rose-100 rounded-lg transition-all flex items-center gap-1 disabled:opacity-50"
                  >
                    {isDeletingThis ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                    {paper.isDuplicate ? 'Delete Duplicate' : 'Delete'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Fix Paper Modal */}
      {editingPaper && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2">
                <Edit3 className="w-5 h-5 text-blue-600" />
                <h3 className="text-base font-bold text-slate-900">Fix Paper Metadata</h3>
              </div>
              <button 
                onClick={() => setEditingPaper(null)} 
                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-200/50"
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
                <Code className="w-3.5 h-3.5" /> Raw JSON
              </button>
            </div>

            {/* Modal Content Body */}
            <div className="p-6 overflow-y-auto flex-grow space-y-4 text-xs">
              {editTab === 'form' ? (
                <>
                  {/* Title */}
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Paper Title</label>
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
                      <label className="block font-semibold text-slate-700 mb-1">Publication Date</label>
                      <input
                        type="text"
                        placeholder="YYYY-MM-DD"
                        value={editingPaper.metadata?.publication_date || ''}
                        onChange={(e) => {
                          setEditingPaper({
                            ...editingPaper,
                            metadata: { ...editingPaper.metadata, publication_date: e.target.value }
                          });
                        }}
                        className="w-full p-2 border border-slate-200 rounded-xl text-xs text-slate-800"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">DOI (optional)</label>
                      <input
                        type="text"
                        placeholder="10.1234/zenodo.5678"
                        value={editingPaper.metadata?.doi || ''}
                        onChange={(e) => {
                          setEditingPaper({
                            ...editingPaper,
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
                          const creators = [...(editingPaper.metadata?.creators || [])];
                          creators.push({ name: '', affiliation: '' });
                          setEditingPaper({
                            ...editingPaper,
                            metadata: { ...editingPaper.metadata, creators }
                          });
                        }}
                        className="text-[11px] text-blue-600 hover:text-blue-800 font-semibold flex items-center gap-1"
                      >
                        + Add Author
                      </button>
                    </div>

                    <div className="space-y-2">
                      {(editingPaper.metadata?.creators || []).map((creator: any, idx: number) => (
                        <div key={idx} className="flex items-center gap-2 bg-slate-50 p-2 border border-slate-200 rounded-xl">
                          <input
                            type="text"
                            placeholder="Author Name"
                            value={creator.name || ''}
                            onChange={(e) => {
                              const creators = [...(editingPaper.metadata?.creators || [])];
                              creators[idx] = { ...creators[idx], name: e.target.value };
                              setEditingPaper({
                                ...editingPaper,
                                metadata: { ...editingPaper.metadata, creators }
                              });
                            }}
                            className="w-1/2 p-1.5 border border-slate-200 rounded-lg text-xs bg-white"
                          />
                          <input
                            type="text"
                            placeholder="Affiliation"
                            value={creator.affiliation || ''}
                            onChange={(e) => {
                              const creators = [...(editingPaper.metadata?.creators || [])];
                              creators[idx] = { ...creators[idx], affiliation: e.target.value };
                              setEditingPaper({
                                ...editingPaper,
                                metadata: { ...editingPaper.metadata, creators }
                              });
                            }}
                            className="w-1/2 p-1.5 border border-slate-200 rounded-lg text-xs bg-white"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const creators = [...(editingPaper.metadata?.creators || [])];
                              creators.splice(idx, 1);
                              setEditingPaper({
                                ...editingPaper,
                                metadata: { ...editingPaper.metadata, creators }
                              });
                            }}
                            className="p-1 text-slate-400 hover:text-rose-600 rounded"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Keywords */}
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Keywords (comma-separated)</label>
                    <input
                      type="text"
                      placeholder="e.g. Artificial Intelligence, Quantum Physics, Data Science"
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
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Edit Metadata as JSON</label>
                  <textarea 
                    value={rawJsonText}
                    onChange={(e) => {
                      setRawJsonText(e.target.value);
                      setRawJsonError(null);
                    }}
                    className="w-full h-80 border border-slate-300 rounded-xl p-3 font-mono text-xs text-slate-800 bg-slate-900 text-slate-100 focus:outline-none"
                  />
                  {rawJsonError && (
                    <div className="mt-2 text-rose-600 text-xs flex items-center gap-1 font-medium">
                      <AlertCircle className="w-4 h-4" /> {rawJsonError}
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
                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-semibold shadow-xs transition-all flex items-center gap-1.5 disabled:opacity-50"
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
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-rose-100 text-rose-600 rounded-full">
                <Trash2 className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Delete Paper</h3>
                <p className="text-xs text-slate-500 mt-0.5">This action cannot be undone.</p>
              </div>
            </div>

            <p className="text-xs text-slate-700 bg-slate-50 p-3 rounded-xl border border-slate-100 font-medium mb-6">
              Are you sure you want to delete <span className="font-bold text-slate-900">"{paperToDelete.title}"</span>?
            </p>

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setPaperToDelete(null)}
                className="px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={() => executeDeletePaper(paperToDelete)}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-xl shadow-xs transition-all flex items-center gap-1.5"
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
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-rose-100 text-rose-600 rounded-full">
                <ShieldAlert className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Delete All Duplicates</h3>
                <p className="text-xs text-slate-500 mt-0.5">Batch removal of duplicate uploads</p>
              </div>
            </div>

            <div className="text-xs text-slate-700 bg-rose-50 border border-rose-100 p-3.5 rounded-xl mb-6 space-y-1">
              <p className="font-semibold text-rose-900">
                Are you sure you want to delete all {duplicatePapers.length} duplicate paper(s)?
              </p>
              <p className="text-rose-700">
                The oldest original copy of each paper will be safely preserved.
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
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-xl shadow-xs transition-all flex items-center gap-1.5 disabled:opacity-50"
              >
                {deletingDuplicates ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Yes, Delete All Duplicates
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
