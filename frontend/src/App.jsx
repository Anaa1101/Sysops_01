import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GraphView } from './components/GraphView';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const markdownComponents = {
  h1: ({ children }) => <h1 className="text-xl font-bold text-sky-300 mt-4 mb-2 border-b border-slate-600 pb-1">{children}</h1>,
  h2: ({ children }) => <h2 className="text-lg font-bold text-sky-300 mt-3 mb-2">{children}</h2>,
  h3: ({ children }) => <h3 className="text-base font-semibold text-sky-200 mt-3 mb-1">{children}</h3>,
  p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc list-inside mb-3 space-y-1 pl-2">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside mb-3 space-y-1 pl-2">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed text-slate-200">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }) => <em className="italic text-slate-300">{children}</em>,
  code: ({ inline, children }) => inline
    ? <code className="bg-slate-900 text-amber-300 text-xs font-mono px-1.5 py-0.5 rounded">{children}</code>
    : <code className="block bg-slate-900 text-amber-300 text-xs font-mono p-3 rounded-lg overflow-x-auto whitespace-pre">{children}</code>,
  pre: ({ children }) => <pre className="mb-3 rounded-lg overflow-hidden">{children}</pre>,
  blockquote: ({ children }) => <blockquote className="border-l-4 border-sky-500 pl-3 my-3 text-slate-400 italic">{children}</blockquote>,
  hr: () => <hr className="border-slate-600 my-3" />,
  table: ({ children }) => <div className="overflow-x-auto mb-3"><table className="w-full text-sm border-collapse">{children}</table></div>,
  thead: ({ children }) => <thead className="bg-slate-900">{children}</thead>,
  th: ({ children }) => <th className="text-left px-3 py-2 text-sky-300 font-semibold border border-slate-600">{children}</th>,
  td: ({ children }) => <td className="px-3 py-2 border border-slate-600 text-slate-300">{children}</td>,
  tr: ({ children }) => <tr className="even:bg-slate-800/50">{children}</tr>,
};

function App() {
  const [messages, setMessages] = useState([]);
  const [textIssue, setTextIssue] = useState("");
  const [image, setImage] = useState(null);
  const [audio, setAudio] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [graphError, setGraphError] = useState(null);

  const [view, setView] = useState("chat");
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [hasConversationGraph, setHasConversationGraph] = useState(false);

  const chatEndRef = useRef(null);

  const resetConversation = () => {
    setMessages([]);
    setTextIssue("");
    setImage(null);
    setAudio(null);
    setError(null);
    setGraphError(null);
    setGraphData({ nodes: [], links: [] });
    setHasConversationGraph(false);
    setView("chat");
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    // Only fetch the full DB graph when no conversation-specific subgraph is active
    if (view === "graph" && !hasConversationGraph) {
      setGraphError(null);
      fetch(`${API_URL}/graph-data`)
        .then(res => res.json())
        .then(data => {
          if (data.error) {
            setGraphError(`Failed to load graph: ${data.error}`);
          } else {
            setGraphData(data);
          }
        })
        .catch(err => setGraphError(`Could not reach the server: ${err.message}`));
    }
  }, [view, hasConversationGraph]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Audio is now a valid standalone input — validate all three
    if (!image && !audio && !textIssue && messages.length === 0) {
      setError("Please provide a photo of the symptom, an audio recording (e.g., beep codes), or a text description to start the diagnostic.");
      return;
    }

    setLoading(true);
    setError(null);

    // Show all submitted inputs in the chat bubble, not just the first one.
    const parts = [];
    if (textIssue) parts.push(textIssue);
    if (image) parts.push(`[Image: ${image.name}]`);
    if (audio) parts.push(`[Audio: ${audio.name}]`);
    const userDisplayMsg = parts.join("  ");

    const newMessages = [...messages, { role: "user", text: userDisplayMsg }];
    setMessages(newMessages);

    const geminiHistory = messages.map(msg => ({
      role: msg.role,
      parts: [{ text: msg.text }]
    }));

    const formData = new FormData();
    if (image) formData.append("image", image);
    if (audio) formData.append("audio", audio);
    if (textIssue) formData.append("text_issue", textIssue);
    formData.append("chat_history", JSON.stringify(geminiHistory));

    setTextIssue("");
    setImage(null);
    setAudio(null);

    try {
      const response = await fetch(`${API_URL}/diagnose`, {
        method: "POST",
        body: formData,
      });
      const data = await response.json();

      // Treat both HTTP error codes AND a backend error field as failures,
      // because unexpected exceptions return HTTP 500 via HTTPException now.
      if (!response.ok || data.error) {
        throw new Error(data.detail || data.error || "An error occurred.");
      }

      // Store image_url, identified_part and confidence alongside the AI text
      setMessages(prev => [...prev, {
        role: "model",
        text: data.ai_response,
        image_url: data.image_url || null,
        identified_part: data.identified_part || null,
        confidence: data.confidence || null,
      }]);

      if (data.graph_data) {
        setGraphData(data.graph_data);
        setHasConversationGraph(true);
        setGraphError(null);
      }

    } catch (err) {
      setError(err.message);
      setMessages(messages);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto h-screen flex flex-col p-4">
      <header className="flex justify-between items-center py-6">
        <div>
          <h1 className="text-sky-400 text-3xl font-bold">SysOps AI</h1>
          <p className="text-slate-400 text-sm">Senior Engineer in a Box — IT Infrastructure Diagnostic Console</p>
        </div>

        <div className="flex items-center gap-3">
          {messages.length > 0 && (
            <button
              id="new-diagnosis-btn"
              onClick={resetConversation}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-lg transition-colors shadow-md"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10"/>
                <path d="M3.51 15a9 9 0 1 0 .49-4.5"/>
              </svg>
              New Diagnosis
            </button>
          )}

          <div className="flex bg-slate-800 rounded-lg p-1">
            <button
              onClick={() => setView('chat')}
              className={`px-4 py-2 rounded-md font-medium transition-colors ${view === 'chat' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              Chat Session
            </button>
            <button
              onClick={() => setView('graph')}
              className={`px-4 py-2 rounded-md font-medium transition-colors ${view === 'graph' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              Database Graph
            </button>
          </div>
        </div>
      </header>

      {view === 'chat' ? (
        <>
          <main className="flex-grow bg-slate-800 rounded-lg shadow-lg overflow-y-auto p-6 mb-4 flex flex-col gap-6">
            {messages.length === 0 ? (
              <div className="text-center text-slate-500 mt-20">
                <p>Upload a photo of the failing component (blinking LEDs, error code on console, faulty PSU), an audio recording of beep codes or alarm tones, or describe the symptom to start the diagnostic session.</p>
              </div>
            ) : (
              messages.map((msg, index) => (
                <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'user' ? (
                    <div className="max-w-[80%] rounded-2xl p-4 bg-sky-600 text-white rounded-br-none">
                      {msg.text}
                    </div>
                  ) : (
                    <div className="max-w-[80%] rounded-2xl p-4 bg-slate-700 text-slate-200 rounded-bl-none">

                      {/* Component image + diagnosis badge — only shown on first response */}
                      {msg.identified_part && msg.identified_part !== "Continuing Conversation" && (
                        <div className="mb-4">
                          {msg.image_url && (
                            <img
                              src={msg.image_url}
                              alt={msg.identified_part}
                              className="w-full max-w-xs rounded-lg mb-2 object-cover border border-slate-600"
                              onError={(e) => { e.currentTarget.style.display = 'none'; }}
                            />
                          )}
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-xs font-semibold px-2 py-1 rounded-full">
                              Identified: {msg.identified_part}
                            </span>
                            {msg.confidence && (
                              <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-xs font-semibold px-2 py-1 rounded-full">
                                Match: {(msg.confidence * 100).toFixed(1)}%
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* AI response text */}
                      <div className="text-slate-200 text-sm leading-relaxed">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {msg.text}
                        </ReactMarkdown>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-slate-700 text-slate-400 p-4 rounded-2xl rounded-bl-none animate-pulse">
                  SysOps is analyzing...
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </main>

          <footer className="bg-slate-800 p-4 rounded-lg shadow-lg">
            {error && (
              <div className="mb-4 p-3 bg-red-900/50 border border-red-500 text-red-200 rounded text-sm">
                {error}
              </div>
            )}
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <div className="flex gap-4 text-sm mb-2">
                <div className="flex-1">
                  <label className="block text-slate-400 mb-1">Symptom Image (LED, error code, hardware) — Optional</label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={e => setImage(e.target.files[0])}
                    className="w-full text-slate-300"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-slate-400 mb-1">Audio Recording (beep codes, alarms) — Optional</label>
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={e => setAudio(e.target.files[0])}
                    className="w-full text-slate-300"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={textIssue}
                  onChange={(e) => setTextIssue(e.target.value)}
                  placeholder="Describe the symptom (e.g., 'Cisco 9300 port amber blinking', 'Dell R740 three short beeps')..."
                  className="flex-grow p-3 bg-slate-900 border border-slate-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="px-6 py-3 bg-sky-600 text-white font-bold rounded-lg hover:bg-sky-700 disabled:bg-slate-600 transition-colors"
                >
                  Send
                </button>
              </div>
            </form>
          </footer>
        </>
      ) : (
        <div className="flex-grow flex flex-col">
          {graphError && (
            <div className="mb-3 p-3 bg-red-900/50 border border-red-500 text-red-200 rounded text-sm">
              {graphError}
            </div>
          )}
          <GraphView graphData={graphData} hasConversationGraph={hasConversationGraph} />
        </div>
      )}
    </div>
  );
}

export default App;
