import React from 'react';
import UserGuide from './UserGuide';
import Logo from './Logo';
import { ExternalLink, Shield, HelpCircle, FileText, Heart } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="bg-slate-950 text-slate-300 border-t border-slate-800 mt-20" role="contentinfo">
      <div className="max-w-7xl mx-auto px-6 py-12 md:py-16">
        
        {/* Main Footer Header */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 pb-12 border-b border-slate-800">
          
          {/* Brand Info */}
          <div className="md:col-span-5 space-y-4">
            <div className="flex items-center gap-3">
              <Logo size="lg" className="w-11 h-11 border-slate-700" />
              <div>
                <span className="text-lg font-bold text-white tracking-tight">ZenUploader</span>
                <p className="text-[11px] text-slate-400">Open Science & Research Automation</p>
              </div>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed max-w-sm">
              ZenUploader is an independent, automated AI uploader for Zenodo (not affiliated with or endorsed by Zenodo or CERN). It extracts research metadata using Gemini AI.
            </p>
            <div className="flex items-center gap-3 text-xs text-slate-400 pt-1">
              <span className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-900 border border-slate-800 rounded-full text-slate-300 font-medium">
                <Shield className="w-3.5 h-3.5 text-emerald-400" /> Open Science Supported
              </span>
              <span className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-900 border border-slate-800 rounded-full text-slate-300 font-medium">
                <FileText className="w-3.5 h-3.5 text-blue-400" /> DataCite Schema
              </span>
            </div>
          </div>

          {/* Useful Links */}
          <div className="md:col-span-3 space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-white">Quick Navigation</h4>
            <ul className="text-xs space-y-2 text-slate-400">
              <li>
                <a href="#uploader-top" className="hover:text-blue-400 transition-colors flex items-center gap-1">
                  Upload PDF Manuscript
                </a>
              </li>
              <li>
                <a href="#submissions-list" className="hover:text-blue-400 transition-colors flex items-center gap-1">
                  Submission History
                </a>
              </li>
              <li>
                <a href="#user-guide" className="hover:text-blue-400 transition-colors flex items-center gap-1">
                  Documentation & User Guide
                </a>
              </li>
              <li>
                <button
                  onClick={() => {
                    const btn = document.getElementById('support-chatbot-toggle');
                    if (btn) btn.click();
                  }}
                  className="hover:text-blue-400 transition-colors flex items-center gap-1 text-left cursor-pointer"
                >
                  <HelpCircle className="w-3.5 h-3.5 text-indigo-400" /> Open AI Support Chatbot
                </button>
              </li>
            </ul>
          </div>

          {/* External Repositories & Community */}
          <div className="md:col-span-4 space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-white">Zenodo & Community</h4>
            <p className="text-xs text-slate-400">
              Zenodo is a researcher-first open-access repository built by CERN under the EU Commission OpenAIRE program.
            </p>
            <div className="pt-1 flex flex-col gap-2 text-xs">
              <a 
                href="https://groups.google.com/g/zenuploader" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-amber-400 hover:text-amber-300 transition-colors inline-flex items-center gap-1.5 font-bold"
              >
                ZenUploader Community Support Group <ExternalLink className="w-3 h-3" />
              </a>
              <a 
                href="https://zenodo.org" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 transition-colors inline-flex items-center gap-1.5 font-medium"
              >
                Zenodo Official Portal <ExternalLink className="w-3 h-3" />
              </a>
              <a 
                href="https://developers.zenodo.org/" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-slate-400 hover:text-slate-200 transition-colors inline-flex items-center gap-1.5"
              >
                Zenodo REST API Developer Docs <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>

        </div>

        {/* Embedded Full User Guide in Footer as explicitly requested */}
        <div className="mt-8">
          <UserGuide />
        </div>

        {/* Bottom Bar */}
        <div className="mt-12 pt-8 border-t border-slate-900 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <p>© {new Date().getFullYear()} ZenUploader. Independent 3rd-party application not affiliated with or endorsed by Zenodo or CERN.</p>
          <p className="flex items-center gap-1">
            Built for Open Access &amp; Scientific Reproducibility <Heart className="w-3 h-3 text-rose-500 fill-rose-500" />
          </p>
        </div>

      </div>
    </footer>
  );
}
