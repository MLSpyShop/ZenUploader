import React, { useState, useEffect } from 'react';
import FileUploader from './components/FileUploader';
import PaperList from './components/PaperList';
import { initAuth } from './auth';
import { User } from 'firebase/auth';
import logoImg from './assets/logo.jpg';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  useEffect(() => {
    initAuth(
      (user) => setUser(user),
      () => setUser(null)
    );
  }, []);

  const handleUploadSuccess = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 min-h-[100px] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img 
              src={logoImg} 
              alt="ZenUploader Logo" 
              className="h-24 sm:h-28 w-auto object-contain rounded-lg" 
              referrerPolicy="no-referrer"
            />
          </div>
          {user && (
            <div className="flex items-center gap-3 text-xs text-slate-600 bg-slate-100 px-3 py-1.5 rounded-full">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="font-medium truncate max-w-[180px]">{user.email}</span>
            </div>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-grow p-6 md:p-12">
        <div className="max-w-4xl mx-auto">
          <FileUploader user={user} onUploadSuccess={handleUploadSuccess} />
          {user && <PaperList user={user} refreshTrigger={refreshTrigger} />}
        </div>
      </main>
    </div>
  );
}
