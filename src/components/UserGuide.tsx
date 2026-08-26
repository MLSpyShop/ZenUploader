import React, { useState } from 'react';
import { 
  BookOpen, 
  FileText, 
  CloudUpload, 
  Key, 
  ShieldCheck, 
  HelpCircle, 
  Sparkles, 
  CheckCircle2, 
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Cpu,
  Layers,
  Database
} from 'lucide-react';

export default function UserGuide() {
  const [activeTab, setActiveTab] = useState<'user' | 'staff'>('user');
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <section className="bg-slate-900 text-slate-100 rounded-3xl border border-slate-800 shadow-2xl overflow-hidden mt-16 text-left" id="user-guide">
      {/* Header Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-blue-950 to-slate-900 px-6 sm:px-10 py-8 border-b border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 shrink-0 shadow-inner">
            <BookOpen className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-blue-500/20 text-blue-300 border border-blue-500/30">
                Official Documentation
              </span>
              <span className="text-xs text-slate-400">v2.4 • Updated</span>
            </div>
            <h2 className="text-2xl font-extrabold text-white tracking-tight mt-1">
              ZenUploader Full User Guide & Documentation
            </h2>
          </div>
        </div>

        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl border border-slate-700 transition-all cursor-pointer"
          aria-expanded={isExpanded}
        >
          {isExpanded ? (
            <><ChevronUp className="w-4 h-4" /> Collapse Guide</>
          ) : (
            <><ChevronDown className="w-4 h-4" /> Expand Full Guide</>
          )}
        </button>
      </div>

      {isExpanded && (
        <div className="p-6 sm:p-10 space-y-8">
          {/* Audience Mode Selector */}
          <div className="flex flex-wrap items-center justify-between gap-4 pb-6 border-b border-slate-800">
            <p className="text-xs text-slate-400">Select guide perspective:</p>
            <div className="flex items-center gap-2 bg-slate-950 p-1 rounded-xl border border-slate-800">
              <button
                onClick={() => setActiveTab('user')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 cursor-pointer ${
                  activeTab === 'user' 
                    ? 'bg-blue-600 text-white shadow-md' 
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                Researcher & Client Guide
              </button>
              <button
                onClick={() => setActiveTab('staff')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 cursor-pointer ${
                  activeTab === 'staff' 
                    ? 'bg-indigo-600 text-white shadow-md' 
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                Zenodo Staff & Business Operations Guide
              </button>
            </div>
          </div>

          {activeTab === 'user' ? (
            /* RESEARCHER & CLIENT GUIDE */
            <div className="space-y-10">
              {/* Overview */}
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-3">
                  <Sparkles className="w-5 h-5 text-blue-400" /> What is ZenUploader?
                </h3>
                <p className="text-sm text-slate-300 leading-relaxed">
                  ZenUploader is an automated AI-powered research assistant designed to publish PDF manuscripts directly to <a href="https://zenodo.org" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline inline-flex items-center gap-1 font-semibold">Zenodo <ExternalLink className="w-3 h-3" /></a>, CERN&apos;s open-access repository. By leveraging advanced multimodal AI, ZenUploader automatically parses manuscript text, generates complete structured metadata (abstracts, keywords, WHOIS author biographies, glossaries, and up to 20 FAQs), and formats rich HTML descriptions for Zenodo.
                </p>

                {/* Third Party & AI Disclaimer Banner */}
                <div className="mt-4 p-4 bg-amber-950/40 border border-amber-800/60 rounded-xl text-xs text-amber-200/90 space-y-1.5">
                  <p className="font-bold text-amber-300 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0" /> Important Notices & Disclaimers:
                  </p>
                  <ul className="list-disc list-inside space-y-1 text-amber-200/80 pl-1">
                    <li><strong>Third-Party Application:</strong> ZenUploader is an independent third-party tool and is <u>not affiliated with or endorsed by Zenodo or CERN</u>.</li>
                    <li><strong>AI Review Requirement:</strong> AI models can make mistakes or generate inaccuracies. Always thoroughly review and verify all extracted metadata before publishing.</li>
                  </ul>
                </div>
              </div>

              {/* Step 1 vs Step 2 Workflow */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="p-6 bg-slate-950 rounded-2xl border border-blue-900/40 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-blue-600/10 rounded-full blur-xl pointer-events-none" />
                  <div className="flex items-center gap-3 mb-4">
                    <span className="w-8 h-8 rounded-xl bg-blue-600 text-white font-black text-sm flex items-center justify-center">1</span>
                    <h4 className="text-base font-bold text-white">Step 1: Process PDF & AI Extraction</h4>
                  </div>
                  <ul className="text-xs text-slate-300 space-y-2.5">
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                      <span>Upload your manuscript PDF directly via drag-and-drop or file selector.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                      <span>Gemini AI scans the text to extract title, abstract, creators, publication date, and funding information.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                      <span>Generates rich value-adds: Executive TL;DRs, 4-8 novelty bullets, 8-15 technical glossary definitions, and up to 20 comprehensive Q&amp;As.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                      <span>Performs live web WHOIS searches to compile academic biographies and institutional affiliations for listed authors.</span>
                    </li>
                  </ul>
                </div>

                <div className="p-6 bg-slate-950 rounded-2xl border border-indigo-900/40 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-600/10 rounded-full blur-xl pointer-events-none" />
                  <div className="flex items-center gap-3 mb-4">
                    <span className="w-8 h-8 rounded-xl bg-indigo-600 text-white font-black text-sm flex items-center justify-center">2</span>
                    <h4 className="text-base font-bold text-white">Step 2: Review & Final Zenodo Upload</h4>
                  </div>
                  <ul className="text-xs text-slate-300 space-y-2.5">
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                      <span>Review and customize any extracted metadata field on the interactive editing dashboard.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                      <span>Input or verify your personal Zenodo API Token saved in local key settings.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                      <span>Click <strong>Step 2: Upload to Zenodo</strong> to publish the manuscript deposition directly onto Zenodo servers.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                      <span>Receive an instant DOI link, HTML record preview, and sync submission to your personal history log.</span>
                    </li>
                  </ul>
                </div>
              </div>

              {/* How to get API keys */}
              <div className="bg-slate-950 p-6 rounded-2xl border border-slate-800 space-y-4">
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  <Key className="w-4 h-4 text-amber-400" /> Generating Your Zenodo API Token
                </h4>
                <ol className="text-xs text-slate-300 space-y-2 list-decimal list-inside">
                  <li>Sign in to your account at <a href="https://zenodo.org/account/settings/applications/" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">zenodo.org/account/settings/applications/</a></li>
                  <li>Click <strong>New Token</strong> under Personal Access Tokens.</li>
                  <li>Name your token (e.g., <code className="bg-slate-800 px-1.5 py-0.5 rounded text-amber-300">ZenUploader</code>) and select scopes: <code className="bg-slate-800 px-1 py-0.5 rounded text-emerald-400">deposit:write</code> and <code className="bg-slate-800 px-1 py-0.5 rounded text-emerald-400">deposit:actions</code>.</li>
                  <li>Copy the generated secret token and paste it into the <strong>Zenodo Access Token</strong> input field in API Settings above.</li>
                </ol>
              </div>
            </div>
          ) : (
            /* ZENODO STAFF & BUSINESS OPERATIONS GUIDE */
            <div className="space-y-10">
              {/* Staff Introduction */}
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-3">
                  <ShieldCheck className="w-5 h-5 text-indigo-400" /> Zenodo Staff & Business Operational Overview
                </h3>
                <p className="text-sm text-slate-300 leading-relaxed">
                  This documentation section provides technical specifications for Zenodo repository staff, curators, compliance auditors, and system administrators managing automated REST submissions, metadata enrichment standards, and rate limits.
                </p>
              </div>

              {/* Architecture & Endpoints */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="p-5 bg-slate-950 rounded-2xl border border-slate-800">
                  <div className="flex items-center gap-2 text-indigo-400 font-bold text-xs uppercase tracking-wider mb-2">
                    <Cpu className="w-4 h-4" /> PDF Extraction Engine
                  </div>
                  <h4 className="text-sm font-bold text-white mb-2">/api/process-pdf</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Receives multipart binary PDF buffers. Executes PDF text parsing, fallback regex string normalization, and Gemini 3.6 multimodal structuring.
                  </p>
                </div>

                <div className="p-5 bg-slate-950 rounded-2xl border border-slate-800">
                  <div className="flex items-center gap-2 text-blue-400 font-bold text-xs uppercase tracking-wider mb-2">
                    <CloudUpload className="w-4 h-4" /> Zenodo REST Bridge
                  </div>
                  <h4 className="text-sm font-bold text-white mb-2">/api/upload-to-zenodo</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Constructs DataCite / Dublin Core compliant JSON payloads with clean HTML descriptions and dispatches draft depositions to <code className="text-blue-300">zenodo.org/api/deposit/depositions</code>.
                  </p>
                </div>

                <div className="p-5 bg-slate-950 rounded-2xl border border-slate-800">
                  <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs uppercase tracking-wider mb-2">
                    <Database className="w-4 h-4" /> Re-indexing & Updates
                  </div>
                  <h4 className="text-sm font-bold text-white mb-2">/api/update-zenodo-paper</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Dispatches <code className="text-emerald-300">PUT</code> requests to update existing draft metadata without re-uploading binary payloads.
                  </p>
                </div>
              </div>

              {/* Compliance & Standards */}
              <div className="p-6 bg-slate-950 rounded-2xl border border-slate-800 space-y-4">
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  <Layers className="w-4 h-4 text-indigo-400" /> Data Quality, Metadata Validation & Rate Limits
                </h4>
                <div className="text-xs text-slate-300 space-y-3">
                  <p>
                    <strong>DataCite JSON Schema Mapping:</strong> All submitted records strictly follow Zenodo REST API specifications:
                  </p>
                  <ul className="list-disc list-inside space-y-1 text-slate-400 pl-2">
                    <li><strong className="text-slate-200">Creators:</strong> Structured with clean author names, validated 16-character ORCIDs, and institutional affiliations.</li>
                    <li><strong className="text-slate-200">Publication Date:</strong> ISO 8601 formatted YYYY-MM-DD string.</li>
                    <li><strong className="text-slate-200">Related Identifiers:</strong> Sanitizes DOI, arXiv, and URL links to prevent schema validation errors.</li>
                    <li><strong className="text-slate-200">Keywords:</strong> Deduplicated, sanitized long-tail index terms.</li>
                  </ul>
                  <p>
                    <strong>API Rate Limit Guidelines:</strong> Zenodo API enforces standard rate limits (100 requests per minute). The backend includes exponential backoff retry mechanisms to handle transient network spikes gracefully.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Quick FAQ Footer & Community Link */}
          <div className="p-6 bg-slate-950/80 rounded-2xl border border-slate-800/80 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs">
            <div className="flex items-center gap-3">
              <HelpCircle className="w-5 h-5 text-blue-400 shrink-0" />
              <div>
                <p className="font-bold text-white">Need help or want to connect with other users?</p>
                <p className="text-slate-400">Join our <a href="https://groups.google.com/g/zenuploader" target="_blank" rel="noopener noreferrer" className="text-amber-400 hover:underline font-semibold inline-flex items-center gap-1">ZenUploader Google Group <ExternalLink className="w-3 h-3" /></a> or chat with the AI Assistant.</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <a
                href="https://groups.google.com/g/zenuploader"
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-amber-300 font-bold rounded-xl transition-all border border-slate-700 flex items-center gap-1.5 shrink-0"
              >
                Community Group <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <a
                href="#support-chat"
                onClick={(e) => {
                  e.preventDefault();
                  const btn = document.getElementById('support-chatbot-toggle');
                  if (btn) btn.click();
                }}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl transition-all shadow-sm shrink-0 cursor-pointer"
              >
                Ask Support Chatbot
              </a>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
