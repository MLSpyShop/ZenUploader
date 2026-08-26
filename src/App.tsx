import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import FileUploader from './components/FileUploader';
import PaperList from './components/PaperList';
import Footer from './components/Footer';
import SupportChatbot from './components/SupportChatbot';
import { initAuth } from './auth';
import { User } from 'firebase/auth';

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
    <div className="min-h-screen bg-slate-50 flex flex-col" id="uploader-top">
      {/* Header */}
      <Header user={user} />

      {/* Main Content */}
      <main className="flex-grow p-4 sm:p-6 md:p-12">
        <div className="max-w-4xl mx-auto space-y-8">
          <FileUploader user={user} onUploadSuccess={handleUploadSuccess} />
          <PaperList user={user} refreshTrigger={refreshTrigger} />
        </div>
      </main>

      {/* Footer & Comprehensive User Guide */}
      <Footer />

      {/* Accessible AI Support Assistant Chatbot */}
      <SupportChatbot />
    </div>
  );
}
