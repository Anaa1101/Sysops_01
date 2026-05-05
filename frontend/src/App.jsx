import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GraphView } from './components/GraphView';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const markdownComponents = {
  h1: ({ children }) => <h1 className="text-xl font-bold text-rose-700 mt-4 mb-2 border-b border-stone-200 pb-1">{children}</h1>,
  h2: ({ children }) => <h2 className="text-lg font-bold text-rose-700 mt-3 mb-2">{children}</h2>,
  h3: ({ children }) => <h3 className="text-base font-semibold text-stone-800 mt-3 mb-1">{children}</h3>,
  p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc list-inside mb-3 space-y-1 pl-2">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside mb-3 space-y-1 pl-2">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed text-stone-700">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-stone-900">{children}</strong>,
  em: ({ children }) => <em className="italic text-stone-500">{children}</em>,
  code: ({ inline, children }) => inline
    ? <code className="bg-stone-100 text-rose-700 text-xs font-mono px-1.5 py-0.5 rounded-md">{children}</code>
    : <code className="block bg-stone-900 text-amber-200 text-xs font-mono p-3 rounded-2xl overflow-x-auto whitespace-pre">{children}</code>,
  pre: ({ children }) => <pre className="mb-3 rounded-2xl overflow-hidden">{children}</pre>,
  blockquote: ({ children }) => <blockquote className="border-l-4 border-emerald-500 pl-3 my-3 text-stone-500 italic">{children}</blockquote>,
  hr: () => <hr className="border-stone-200 my-3" />,
  table: ({ children }) => <div className="overflow-x-auto mb-3"><table className="w-full text-sm border-collapse">{children}</table></div>,
  thead: ({ children }) => <thead className="bg-stone-100">{children}</thead>,
  th: ({ children }) => <th className="text-left px-3 py-2 text-stone-800 font-semibold border border-stone-200">{children}</th>,
  td: ({ children }) => <td className="px-3 py-2 border border-stone-200 text-stone-700">{children}</td>,
  tr: ({ children }) => <tr className="even:bg-stone-50">{children}</tr>,
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

    if (!image && !audio && !textIssue && messages.length === 0) {
      setError("Please provide a photo of the symptom, an audio recording (e.g., beep codes), or a text description to start the diagnostic.");
      return;
    }

    setLoading(true);
    setError(null);

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

      if (!response.ok || data.error) {
        throw new Error(data.detail || data.error || "An error occurred.");
      }

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
          <h1 className="text-3xl font-extrabold text-stone-900 tracking-tight">SysOps AI</h1>
          <p className="text-stone-500 text-sm mt-0.5">Senior Engineer in a Box — IT Infrastructure Diagnostic Console</p>
        </div>

        <div className="flex items-center gap-3">
          {messages.length > 0 && (
            <button
              id="new-diagnosis-btn"
              onClick={resetConversation}
              className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-full transition-colors shadow-md"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10"/>
                <path d="M3.51 15a9 9 0 1 0 .49-4.5"/>
              </svg>
              New Diagnosis
            </button>
          )}

          <div className="flex bg-stone-100 border border-stone-200 rounded-full p-1">
            <button
              onClick={() => setView('chat')}
              className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${view === 'chat' ? 'bg-rose-500 text-white shadow' : 'text-stone-600 hover:text-stone-900'}`}
            >
              Chat Session
            </button>
            <button
              onClick={() => setView('graph')}
              className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${view === 'graph' ? 'bg-rose-500 text-white shadow' : 'text-stone-600 hover:text-stone-900'}`}
            >
              Database Graph
            </button>
          </div>
        </div>
      </header>

      {view === 'chat' ? (
        <>
          <main className="flex-grow bg-white rounded-3xl shadow-lg border border-stone-200 overflow-y-auto p-6 mb-4 flex flex-col gap-5">
            {messages.length === 0 ? (
              <div className="m-auto max-w-md text-center py-10">
                <div className="w-16 h-16 mx-auto rounded-3xl bg-rose-100 text-rose-600 flex items-center justify-center mb-5">
                  <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                  </svg>
                </div>
                <h3 className="text-xl font-bold text-stone-900 mb-2">What's broken?</h3>
                <p className="text-sm text-stone-500 leading-relaxed">
                  Upload a photo of the failing component (blinking LEDs, error code on console), an audio recording of beep codes or alarm tones, or describe the symptom to start.
                </p>
              </div>
            ) : (
              messages.map((msg, index) => (
                <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'user' ? (
                    <div className="max-w-[80%] rounded-3xl rounded-br-md px-5 py-3 bg-stone-900 text-stone-50 text-sm leading-relaxed">
                      {msg.text}
                    </div>
                  ) : (
                    <div className="max-w-[85%] rounded-3xl rounded-bl-md px-5 py-4 bg-stone-50 border border-stone-200">

                      {msg.identified_part && msg.identified_part !== "Continuing Conversation" && (
                        <div className="mb-3">
                          {msg.image_url && (
                            <img
                              src={msg.image_url}
                              alt={msg.identified_part}
                              className="w-full max-w-[260px] rounded-2xl mb-2 object-cover"
                              onError={(e) => { e.currentTarget.style.display = 'none'; }}
                            />
                          )}
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="bg-amber-100 text-amber-800 border border-amber-200 text-[11px] font-semibold px-2.5 py-1 rounded-full">
                              {msg.identified_part}
                            </span>
                            {msg.confidence && (
                              <span className="bg-emerald-100 text-emerald-800 border border-emerald-200 text-[11px] font-semibold px-2.5 py-1 rounded-full">
                                Match {(msg.confidence * 100).toFixed(0)}%
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="text-sm text-stone-800 leading-relaxed">
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
                <div className="bg-stone-100 border border-stone-200 text-stone-500 px-5 py-3 rounded-3xl rounded-bl-md animate-pulse text-sm">
                  SysOps is analyzing…
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </main>

          <footer className="bg-white border border-stone-200 p-4 rounded-3xl shadow-lg">
            {error && (
              <div className="mb-3 p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl text-sm">
                {error}
              </div>
            )}
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <div className="flex gap-4 text-sm mb-1">
                <div className="flex-1">
                  <label className="block text-stone-500 mb-1 text-xs font-medium">Symptom Image (LED, error code, hardware) — Optional</label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={e => setImage(e.target.files[0])}
                    className="w-full text-stone-700 text-sm"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-stone-500 mb-1 text-xs font-medium">Audio Recording (beep codes, alarms) — Optional</label>
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={e => setAudio(e.target.files[0])}
                    className="w-full text-stone-700 text-sm"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={textIssue}
                  onChange={(e) => setTextIssue(e.target.value)}
                  placeholder="Describe the symptom (e.g., 'Cisco 9300 port amber blinking', 'Dell R740 three short beeps')..."
                  className="flex-grow px-5 py-3 bg-stone-50 border border-stone-200 rounded-full text-stone-900 placeholder:text-stone-400 focus:outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-200 transition"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="px-6 py-3 bg-rose-500 text-white text-sm font-bold rounded-full hover:bg-rose-600 disabled:bg-stone-300 disabled:text-stone-500 transition-colors shadow-md"
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
            <div className="mb-3 p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl text-sm">
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
