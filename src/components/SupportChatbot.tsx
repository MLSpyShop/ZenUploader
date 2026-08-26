import React, { useState, useRef, useEffect } from 'react';
import { 
  Bot, 
  X, 
  Send, 
  User as UserIcon, 
  Sparkles, 
  Loader2, 
  HelpCircle, 
  ShieldCheck, 
  FileText, 
  Copy, 
  Check, 
  RefreshCw,
  BookOpen,
  ChevronRight,
  Users,
  ExternalLink
} from 'lucide-react';

interface Message {
  id: string;
  sender: 'user' | 'bot';
  content: string;
  timestamp: string;
  mode?: 'user' | 'staff';
}

export default function SupportChatbot() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'user' | 'staff'>('user');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome-msg',
      sender: 'bot',
      content: `Hello! 👋 I am your **ZenUploader AI Assistant**.

I provide **Client Support for Researchers** and **Business Operational Support for Zenodo Staff**.

Click **"what is this and how does it work?"** below for an instant summary of our User Guide, or join our community at [groups.google.com/g/zenuploader](https://groups.google.com/g/zenuploader)!`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      mode: 'user'
    }
  ]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom of chat
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [messages, isOpen]);

  // Keyboard escape listener to close chat accessibility
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const handleSend = async (customPrompt?: string) => {
    const promptToSend = customPrompt || input;
    if (!promptToSend.trim() || loading) return;

    const userMsg: Message = {
      id: `user-${Date.now()}`,
      sender: 'user',
      content: promptToSend.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      mode: activeTab
    };

    setMessages(prev => [...prev, userMsg]);
    if (!customPrompt) setInput('');
    setLoading(true);

    try {
      // Build conversation history for API call
      const history = messages
        .filter(m => m.id !== 'welcome-msg')
        .map(m => ({
          role: m.sender === 'user' ? 'user' : 'model',
          content: m.content
        }));

      history.push({ role: 'user', content: promptToSend.trim() });

      const res = await fetch('/api/support-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: history,
          audience: activeTab,
          prompt: promptToSend.trim()
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || 'Failed to communicate with AI support assistant.');
      }

      const data = await res.json();
      const botResponse = data.reply || "I'm sorry, I couldn't process your request right now.";

      const botMsg: Message = {
        id: `bot-${Date.now()}`,
        sender: 'bot',
        content: botResponse,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        mode: activeTab
      };

      setMessages(prev => [...prev, botMsg]);
    } catch (err: any) {
      console.error('Support chat error:', err);
      const errorMsg: Message = {
        id: `err-${Date.now()}`,
        sender: 'bot',
        content: `⚠️ **Support Assistant Notice**: ${err.message || 'Unable to connect to support assistant. Please try again or check the full User Guide in the website footer.'}`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        mode: activeTab
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const suggestedPrompts = [
    {
      label: 'what is this and how does it work?',
      icon: <BookOpen className="w-3.5 h-3.5 text-blue-500" />,
      audience: 'all'
    },
    {
      label: 'Where is the community support group?',
      icon: <Users className="w-3.5 h-3.5 text-amber-400" />,
      audience: 'all'
    },
    {
      label: 'How do I generate a Zenodo API token?',
      icon: <HelpCircle className="w-3.5 h-3.5 text-amber-500" />,
      audience: 'user'
    },
    {
      label: 'What metadata is extracted from my PDF?',
      icon: <FileText className="w-3.5 h-3.5 text-emerald-500" />,
      audience: 'user'
    },
    {
      label: 'Staff: How to review or update a Zenodo deposition',
      icon: <ShieldCheck className="w-3.5 h-3.5 text-indigo-500" />,
      audience: 'staff'
    }
  ];

  return (
    <>
      {/* Accessible Floating Toggle Button */}
      <button
        id="support-chatbot-toggle"
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Open AI Client & Staff Support Chatbot"
        aria-expanded={isOpen}
        className="fixed bottom-6 right-6 z-50 p-4 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white rounded-full shadow-2xl transition-all duration-300 transform hover:scale-105 focus:outline-none focus:ring-4 focus:ring-blue-400/50 flex items-center gap-3 group cursor-pointer"
      >
        <div className="relative">
          <Bot className="w-6 h-6 text-white" />
          <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-400 border-2 border-slate-900 rounded-full animate-ping" />
          <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-400 border-2 border-slate-900 rounded-full" />
        </div>
        <span className="hidden sm:inline font-bold text-sm tracking-wide pr-1">
          Support AI
        </span>
      </button>

      {/* Accessible Support Chat Drawer / Modal */}
      {isOpen && (
        <div 
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-end sm:p-6 bg-slate-950/40 backdrop-blur-xs transition-opacity duration-200"
          role="dialog"
          aria-modal="true"
          aria-labelledby="chatbot-title"
        >
          <div className="w-full sm:w-[480px] h-[85vh] sm:h-[640px] max-h-[90vh] bg-slate-900 text-slate-100 rounded-t-3xl sm:rounded-3xl border border-slate-800 shadow-2xl flex flex-col overflow-hidden animate-in slide-in-from-bottom-4 duration-300">
            
            {/* Header */}
            <div className="bg-slate-950 px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-md">
                  <Bot className="w-5 h-5" />
                </div>
                <div>
                  <h3 id="chatbot-title" className="text-sm font-bold text-white flex items-center gap-2">
                    ZenUploader Support AI
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-blue-500/20 text-blue-300 border border-blue-500/30">
                      Live
                    </span>
                  </h3>
                  <p className="text-[11px] text-slate-400">Client Support &amp; Zenodo Business Staff Assistant</p>
                </div>
              </div>

              <button
                onClick={() => setIsOpen(false)}
                aria-label="Close support chat"
                className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-all cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Support Audience Mode Selector */}
            <div className="bg-slate-950/80 px-4 py-2 border-b border-slate-800/80 flex items-center justify-between text-xs">
              <span className="text-slate-400 font-medium text-[11px]">Mode:</span>
              <div className="flex items-center gap-1.5 bg-slate-900 p-1 rounded-xl border border-slate-800">
                <button
                  onClick={() => setActiveTab('user')}
                  className={`px-3 py-1 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                    activeTab === 'user' 
                      ? 'bg-blue-600 text-white shadow-xs' 
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <UserIcon className="w-3 h-3" />
                  Client Support
                </button>
                <button
                  onClick={() => setActiveTab('staff')}
                  className={`px-3 py-1 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                    activeTab === 'staff' 
                      ? 'bg-indigo-600 text-white shadow-xs' 
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <ShieldCheck className="w-3 h-3" />
                  Zenodo Staff
                </button>
              </div>
            </div>

            {/* Chat Body */}
            <div className="flex-1 p-4 overflow-y-auto space-y-4 bg-slate-900/50" role="region" aria-live="polite">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex items-start gap-2.5 ${
                    msg.sender === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  {msg.sender === 'bot' && (
                    <div className="w-7 h-7 rounded-xl bg-blue-600/30 border border-blue-500/40 flex items-center justify-center text-blue-300 shrink-0 mt-0.5">
                      <Bot className="w-4 h-4" />
                    </div>
                  )}

                  <div
                    className={`max-w-[85%] rounded-2xl p-3.5 text-xs leading-relaxed shadow-xs relative group ${
                      msg.sender === 'user'
                        ? 'bg-blue-600 text-white rounded-tr-xs font-medium'
                        : 'bg-slate-950 text-slate-200 border border-slate-800 rounded-tl-xs'
                    }`}
                  >
                    <div className="whitespace-pre-wrap font-sans">
                      {msg.content.split('\n').map((line, idx) => {
                        // Basic markdown parsing for bold text
                        const parts = line.split(/(\*\*.*?\*\*)/g);
                        return (
                          <div key={idx} className={line.startsWith('- ') ? 'pl-2 text-slate-300' : ''}>
                            {parts.map((p, pIdx) => {
                              if (p.startsWith('**') && p.endsWith('**')) {
                                return <strong key={pIdx} className="font-bold text-white">{p.slice(2, -2)}</strong>;
                              }
                              return p;
                            })}
                          </div>
                        );
                      })}
                    </div>

                    <div className="mt-2 pt-1 border-t border-slate-800/40 flex items-center justify-between gap-2 text-[10px] text-slate-400">
                      <span>{msg.timestamp}</span>
                      {msg.sender === 'bot' && (
                        <button
                          onClick={() => handleCopy(msg.id, msg.content)}
                          className="hover:text-white transition-colors cursor-pointer opacity-70 group-hover:opacity-100"
                          title="Copy message"
                        >
                          {copiedId === msg.id ? (
                            <Check className="w-3 h-3 text-emerald-400" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  {msg.sender === 'user' && (
                    <div className="w-7 h-7 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300 shrink-0 mt-0.5">
                      <UserIcon className="w-4 h-4" />
                    </div>
                  )}
                </div>
              ))}

              {loading && (
                <div className="flex items-center gap-2 text-xs text-slate-400 bg-slate-950/80 p-3 rounded-xl border border-slate-800/80 w-fit">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                  <span>Support AI is synthesizing guide response...</span>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Suggested Prompts Section */}
            <div className="p-3 bg-slate-950 border-t border-slate-800">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center justify-between">
                <span>Suggested Questions:</span>
                <span className="text-blue-400 text-[9px]">Click to ask</span>
              </p>
              <div className="flex flex-col gap-1.5 max-h-32 overflow-y-auto">
                {suggestedPrompts.map((p, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSend(p.label)}
                    disabled={loading}
                    className="w-full text-left p-2 bg-slate-900 hover:bg-blue-950/80 border border-slate-800 hover:border-blue-500/50 rounded-xl transition-all flex items-center justify-between text-xs text-slate-200 group cursor-pointer disabled:opacity-50"
                  >
                    <span className="flex items-center gap-2 font-medium truncate">
                      {p.icon}
                      <span className={p.label === 'what is this and how does it work?' ? 'font-bold text-blue-300' : ''}>
                        {p.label}
                      </span>
                    </span>
                    <ChevronRight className="w-3.5 h-3.5 text-slate-500 group-hover:text-blue-400 shrink-0" />
                  </button>
                ))}
              </div>
            </div>

            {/* Input Form */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSend();
              }}
              className="p-3 bg-slate-950 border-t border-slate-800 flex items-center gap-2"
            >
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={activeTab === 'user' ? "Ask about uploading PDFs, Zenodo keys, or metadata..." : "Ask about Zenodo staff curation, API schemas, updates..."}
                disabled={loading}
                className="flex-1 bg-slate-900 text-slate-100 text-xs px-3.5 py-2.5 rounded-xl border border-slate-800 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder:text-slate-500"
              />
              <button
                type="submit"
                disabled={!input.trim() || loading}
                aria-label="Send support question"
                className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 text-white rounded-xl transition-all font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer disabled:cursor-not-allowed shadow-sm shrink-0"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </form>

          </div>
        </div>
      )}
    </>
  );
}
