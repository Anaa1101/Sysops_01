import { useState, useRef, useCallback, useEffect } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

const NODE_CONFIG = {
  Device:     { color: '#38bdf8', glow: '#0ea5e9', label: 'Devices' },
  Component:  { color: '#fbbf24', glow: '#f59e0b', label: 'Components' },
  Resolution: { color: '#34d399', glow: '#10b981', label: 'Resolutions' },
};

const LINK_CONFIG = {
  HAS_COMPONENT:  { color: '#818cf8', label: 'Has Component' },
  HAS_RESOLUTION: { color: '#34d399', label: 'Has Resolution' },
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

export function GraphView({ graphData, hasConversationGraph }) {
  const fgRef        = useRef(null);
  const containerRef = useRef(null);

  const [dims, setDims]                 = useState({ width: 800, height: 500 });
  const [selectedNode, setSelectedNode] = useState(null);
  const [hoveredNode, setHoveredNode]   = useState(null);
  const [highlightNodes, setHighlightNodes] = useState(new Set());
  const [highlightLinks, setHighlightLinks] = useState(new Set());
  const [searchQuery, setSearchQuery]   = useState('');

  // Responsive sizing via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setDims({ width: Math.max(200, width), height: Math.max(200, height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-fit when graph data changes
  useEffect(() => {
    if (!graphData.nodes.length) return;
    const t = setTimeout(() => fgRef.current?.zoomToFit(500, 60), 500);
    return () => clearTimeout(t);
  }, [graphData]);

  // Reset UI state when graph is replaced
  useEffect(() => {
    setSelectedNode(null);
    setHoveredNode(null);
    setHighlightNodes(new Set());
    setHighlightLinks(new Set());
    setSearchQuery('');
  }, [graphData]);

  // Cleanup cursor on unmount
  useEffect(() => () => { document.body.style.cursor = 'default'; }, []);

  const getNeighbors = useCallback((node) => {
    const nodes = new Set([node.id]);
    const links = new Set();
    graphData.links.forEach(link => {
      const s = typeof link.source === 'object' ? link.source.id : link.source;
      const t = typeof link.target === 'object' ? link.target.id : link.target;
      if (s === node.id || t === node.id) {
        nodes.add(s);
        nodes.add(t);
        links.add(link);
      }
    });
    return { nodes, links };
  }, [graphData.links]);

  const handleNodeHover = useCallback((node) => {
    setHoveredNode(node || null);
    if (node) {
      const { nodes, links } = getNeighbors(node);
      setHighlightNodes(nodes);
      setHighlightLinks(links);
    } else {
      setHighlightNodes(new Set());
      setHighlightLinks(new Set());
    }
    document.body.style.cursor = node ? 'pointer' : 'default';
  }, [getNeighbors]);

  const handleNodeClick = useCallback((node) => {
    setSelectedNode(prev => prev?.id === node.id ? null : node);
  }, []);

  // Custom node canvas painter
  const paintNode = useCallback((node, ctx, globalScale) => {
    const cfg          = NODE_CONFIG[node.label] ?? { color: '#94a3b8', glow: '#94a3b8' };
    const isHighlit    = highlightNodes.size === 0 || highlightNodes.has(node.id);
    const isSelected   = selectedNode?.id === node.id;
    const isHovered    = hoveredNode?.id === node.id;
    const isMatch      = searchQuery.length > 1 &&
      node.name.toLowerCase().includes(searchQuery.toLowerCase());

    const r     = isSelected || isHovered ? 10 : 8;
    const alpha = highlightNodes.size > 0 && !isHighlit ? 0.1 : 1;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Glow ring
    if (isSelected || isHovered || isMatch) {
      ctx.shadowBlur  = 20;
      ctx.shadowColor = isMatch ? '#fbbf24' : cfg.glow;
    }

    // Node body
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = cfg.color;
    ctx.fill();

    // Border
    if (isSelected || isMatch) {
      ctx.strokeStyle = isMatch ? '#fbbf24' : '#ffffff';
      ctx.lineWidth   = Math.max(1, 2 / globalScale);
      ctx.stroke();
    }

    ctx.shadowBlur = 0;

    // Label
    const maxLen = 20;
    const label  = node.name.length > maxLen ? node.name.slice(0, maxLen - 1) + '…' : node.name;
    const fs     = Math.max(3, 10 / globalScale);
    ctx.font     = `${isSelected || isHovered ? '600 ' : ''}${fs}px Inter, system-ui, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';

    const tw  = ctx.measureText(label).width;
    const pad = Math.max(1, 2.5 / globalScale);
    const lx  = node.x;
    const ly  = node.y + r + Math.max(1, 3 / globalScale);

    // Label pill background
    roundRect(ctx, lx - tw / 2 - pad, ly - pad * 0.5, tw + pad * 2, fs + pad * 1.5, Math.max(1, 2 / globalScale));
    ctx.fillStyle = 'rgba(15,23,42,0.85)';
    ctx.fill();

    // Label text
    ctx.fillStyle = isHighlit ? '#f1f5f9' : '#475569';
    ctx.fillText(label, lx, ly + pad * 0.25);

    ctx.restore();
  }, [highlightNodes, selectedNode, hoveredNode, searchQuery]);

  const getLinkColor = useCallback((link) => {
    const isHighlit = highlightLinks.size === 0 || highlightLinks.has(link);
    const base = LINK_CONFIG[link.label]?.color ?? '#475569';
    return isHighlit ? base : 'rgba(71,85,105,0.1)';
  }, [highlightLinks]);

  const getLinkWidth = useCallback((link) =>
    highlightLinks.has(link) ? 2 : 1,
  [highlightLinks]);

  const getLinkParticles = useCallback((link) =>
    highlightLinks.has(link) ? 3 : 0,
  [highlightLinks]);

  // Derived stats
  const nodeCounts = {};
  graphData.nodes.forEach(n => { nodeCounts[n.label] = (nodeCounts[n.label] || 0) + 1; });

  const searchMatches = searchQuery.length > 1
    ? graphData.nodes.filter(n => n.name.toLowerCase().includes(searchQuery.toLowerCase())).length
    : 0;

  // Neighbors of selected node for detail panel
  const selectedNeighbors = selectedNode ? (() => {
    const result = [];
    graphData.links.forEach(link => {
      const s = typeof link.source === 'object' ? link.source : graphData.nodes.find(n => n.id === link.source);
      const t = typeof link.target === 'object' ? link.target : graphData.nodes.find(n => n.id === link.target);
      if (s?.id === selectedNode.id) result.push({ node: t, rel: link.label });
      if (t?.id === selectedNode.id) result.push({ node: s, rel: link.label });
    });
    return result.filter(x => x.node);
  })() : [];

  return (
    <div className="flex-grow flex flex-col bg-slate-950 rounded-xl border border-slate-700/60 overflow-hidden shadow-2xl">

      {/* ── Toolbar ── */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-700/60 flex-shrink-0 gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-1.5 text-slate-400 text-xs font-mono">
            <span className="text-slate-300 font-semibold">{graphData.nodes.length}</span>
            <span>nodes</span>
            <span className="text-slate-700">·</span>
            <span className="text-slate-300 font-semibold">{graphData.links.length}</span>
            <span>edges</span>
          </div>

          {hasConversationGraph ? (
            <span className="flex items-center gap-1.5 bg-emerald-950/60 border border-emerald-500/30 text-emerald-300 text-xs font-semibold px-2.5 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
              RAG context
            </span>
          ) : (
            <span className="flex items-center gap-1.5 bg-slate-800/60 border border-slate-600/40 text-slate-500 text-xs font-medium px-2.5 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-600 inline-block" />
              Full database
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Search */}
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none"
              fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search nodes…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="bg-slate-800 border border-slate-700 text-slate-300 text-xs placeholder-slate-600
                         rounded-lg pl-8 pr-7 py-1.5 focus:outline-none focus:border-sky-500
                         focus:ring-1 focus:ring-sky-500/20 w-36 transition-all duration-200 focus:w-48"
            />
            {searchQuery.length > 1 && (
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-semibold text-sky-400 pointer-events-none">
                {searchMatches}
              </span>
            )}
          </div>

          {/* Zoom to fit */}
          <button
            onClick={() => fgRef.current?.zoomToFit(400, 60)}
            title="Zoom to fit"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700
                       border border-slate-700 text-slate-300 text-xs rounded-lg transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
            Fit
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* ── Left sidebar ── */}
        <div className="w-52 flex-shrink-0 bg-slate-900/60 border-r border-slate-700/50 flex flex-col overflow-y-auto">
          <div className="p-4 space-y-5">

            {/* Node types */}
            <div>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">
                Node Types
              </p>
              <div className="space-y-2.5">
                {Object.entries(NODE_CONFIG).map(([type, cfg]) => (
                  <div key={type} className="flex items-center justify-between group">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0 shadow-sm"
                        style={{ backgroundColor: cfg.color, boxShadow: `0 0 6px ${cfg.glow}80` }}
                      />
                      <span className="text-xs text-slate-300">{cfg.label}</span>
                    </div>
                    <span className="text-[10px] font-mono bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded border border-slate-700">
                      {nodeCounts[type] ?? 0}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Relationships */}
            <div>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">
                Relationships
              </p>
              <div className="space-y-2.5">
                {Object.entries(LINK_CONFIG).map(([type, cfg]) => (
                  <div key={type} className="flex items-center gap-2.5">
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <div className="w-5 h-px" style={{ backgroundColor: cfg.color }} />
                      <svg className="w-2 h-2" style={{ color: cfg.color }} viewBox="0 0 8 8" fill="currentColor">
                        <polygon points="0,1.5 0,6.5 7,4" />
                      </svg>
                    </div>
                    <span className="text-xs text-slate-400">{cfg.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Interaction hints */}
            <div className="border-t border-slate-700/50 pt-4 space-y-1.5">
              <p className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-2">Controls</p>
              {[
                ['Click', 'Select a node'],
                ['Hover', 'Highlight neighbors'],
                ['Scroll', 'Zoom in / out'],
                ['Drag', 'Pan the canvas'],
              ].map(([key, desc]) => (
                <div key={key} className="flex items-start gap-2">
                  <span className="text-[10px] font-mono bg-slate-800 text-slate-500 px-1 py-0.5 rounded border border-slate-700 flex-shrink-0 leading-tight mt-px">
                    {key}
                  </span>
                  <span className="text-[11px] text-slate-600">{desc}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Selected node detail — pinned to bottom of sidebar */}
          {selectedNode && (
            <div className="mt-auto border-t border-slate-700/50 p-4">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2.5">
                Selected
              </p>
              <div className="bg-slate-950 rounded-xl p-3 border border-slate-700/60 shadow-inner">
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: NODE_CONFIG[selectedNode.label]?.color ?? '#94a3b8' }}
                  />
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    {selectedNode.label}
                  </span>
                </div>
                <p className="text-sm font-semibold text-white break-words leading-snug mb-2.5">
                  {selectedNode.name}
                </p>

                {selectedNeighbors.length > 0 && (
                  <div className="space-y-1.5 border-t border-slate-800 pt-2.5">
                    <p className="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-1">
                      Connected to
                    </p>
                    {selectedNeighbors.slice(0, 6).map((nb, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <span
                          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: NODE_CONFIG[nb.node?.label]?.color ?? '#94a3b8' }}
                        />
                        <span className="text-[11px] text-slate-400 truncate" title={nb.node?.name}>
                          {nb.node?.name}
                        </span>
                      </div>
                    ))}
                    {selectedNeighbors.length > 6 && (
                      <p className="text-[10px] text-slate-600 pl-3">
                        +{selectedNeighbors.length - 6} more
                      </p>
                    )}
                  </div>
                )}

                <button
                  onClick={() => setSelectedNode(null)}
                  className="mt-3 text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
                >
                  ✕ Deselect
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Graph canvas ── */}
        <div ref={containerRef} className="flex-1 relative overflow-hidden bg-[#0a0f1e]">
          <ForceGraph2D
            ref={fgRef}
            graphData={graphData}
            width={dims.width}
            height={dims.height}
            backgroundColor="#0a0f1e"
            nodeCanvasObject={paintNode}
            nodeCanvasObjectMode={() => 'replace'}
            nodeLabel=""
            nodeRelSize={8}
            linkColor={getLinkColor}
            linkWidth={getLinkWidth}
            linkDirectionalArrowLength={5}
            linkDirectionalArrowRelPos={1}
            linkDirectionalArrowColor={getLinkColor}
            linkDirectionalParticles={getLinkParticles}
            linkDirectionalParticleWidth={2}
            linkDirectionalParticleSpeed={0.005}
            linkDirectionalParticleColor={getLinkColor}
            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            cooldownTicks={150}
            onEngineStop={() => fgRef.current?.zoomToFit(500, 60)}
            d3AlphaDecay={0.02}
            d3VelocityDecay={0.35}
          />

          {/* Hover tooltip */}
          {hoveredNode && (
            <div className="absolute bottom-5 left-1/2 -translate-x-1/2 pointer-events-none z-20">
              <div className="flex items-center gap-2 bg-slate-900/95 backdrop-blur-sm border border-slate-600/50
                              rounded-xl px-4 py-2.5 shadow-2xl text-sm whitespace-nowrap">
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: NODE_CONFIG[hoveredNode.label]?.color ?? '#94a3b8' }}
                />
                <span className="text-slate-400">{hoveredNode.label}</span>
                <span className="w-px h-3 bg-slate-700" />
                <span className="text-white font-semibold">{hoveredNode.name}</span>
              </div>
            </div>
          )}

          {/* Empty state */}
          {graphData.nodes.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <div className="w-16 h-16 rounded-2xl bg-slate-800/60 border border-slate-700/50 flex items-center justify-center mb-4">
                <svg className="w-8 h-8 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" />
                </svg>
              </div>
              <p className="text-slate-500 text-sm font-semibold mb-1">No graph data</p>
              <p className="text-slate-700 text-xs text-center max-w-xs">
                Run a diagnostic in the Chat Session tab to see the knowledge graph for that device.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
