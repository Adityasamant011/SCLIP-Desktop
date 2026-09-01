import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Bot, Brain, Check, ChevronDown, Clipboard, Loader2, Plus, Send, Square, Wrench, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/shared/ui/cn'
import { copyEditorDiagnosticReport } from '@/infrastructure/editor-diagnostics'

interface SclipTerminalPanelProps {
  projectId: string
  onClose?: () => void
}

interface GatewayConnection { url: string }
interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string }
interface SessionInfo { model?: string; provider?: string }
interface GatewayFrame {
  id?: string | number
  result?: any
  error?: { message?: string }
  method?: string
  params?: { type?: string; session_id?: string; payload?: Record<string, unknown> }
}
interface PendingRequest {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeoutId: number
}
interface AgentActivity {
  key: string
  type: 'tool'
  name: string
  label: string
  status: 'running' | 'complete'
  args?: string
  result?: string
  summary?: string
  context?: string
}

interface ReasoningTrace {
  key: string
  type: 'reasoning'
  content: string
}

type AgentTraceEntry = AgentActivity | ReasoningTrace

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof part === 'object' && part
            ? String((part as { text?: unknown }).text ?? '')
            : '',
      )
      .join('')
  }
  return ''
}

function historyToMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return []
    const message = item as { role?: unknown; content?: unknown; id?: unknown; row_id?: unknown }
    if (message.role !== 'user' && message.role !== 'assistant') return []
    const content = textContent(message.content).trim()
    return content
      ? [{
          id: String(message.id ?? message.row_id ?? `${message.role}-${index}`),
          role: message.role,
          content,
        }]
      : []
  })
}

function inlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index} className="font-semibold text-zinc-100">{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index} className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[0.92em] text-violet-200">{part.slice(1, -1)}</code>
    }
    return part
  })
}

/** Small safe Markdown renderer for model output; it never interprets HTML. */
function MarkdownMessage({ content }: { content: string }) {
  const lines = content.split('\n')
  let inCodeBlock = false
  return <div className="space-y-2">
    {lines.map((rawLine, index) => {
      const line = rawLine.trimEnd()
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock
        return null
      }
      if (inCodeBlock) {
        return <pre key={index} className="overflow-x-auto rounded-md bg-zinc-900 px-2.5 py-1 font-mono text-xs text-zinc-300">{rawLine}</pre>
      }
      if (!line.trim()) return <div key={index} className="h-1" />
      const heading = line.match(/^#{1,4}\s+(.+)$/)
      if (heading) return <p key={index} className="pt-1 font-semibold text-zinc-100">{inlineMarkdown(heading[1])}</p>
      const bullet = line.match(/^\s*[-*]\s+(.+)$/)
      if (bullet) return <div key={index} className="flex gap-2"><span className="text-zinc-500">•</span><p className="min-w-0">{inlineMarkdown(bullet[1])}</p></div>
      const numbered = line.match(/^\s*(\d+\.)\s+(.+)$/)
      if (numbered) return <div key={index} className="flex gap-2"><span className="text-zinc-500">{numbered[1]}</span><p className="min-w-0">{inlineMarkdown(numbered[2])}</p></div>
      return <p key={index}>{inlineMarkdown(line)}</p>
    })}
  </div>
}

function friendlyToolLabel(rawName: string): string {
  const name = rawName
    .replace(/^mcp__sclip_editor__/, '')
    .replace(/^mcp__[^_]+__/, '')
    .replace(/^video_/, '')
  const known: Record<string, string> = {
    tool_search: 'Finding editor tools',
    resolve_reference: 'Inspecting timeline item',
    get_project: 'Reading project state',
    list_media: 'Inspecting project media',
    get_timeline: 'Reading the timeline',
    add_clip: 'Adding clip to timeline',
    update_item: 'Updating timeline item',
    export: 'Exporting the project',
  }
  if (known[name]) return known[name]
  const words = name.replace(/[_-]+/g, ' ').trim()
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : 'Working in the editor'
}

function stringifyActivityValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function AgentTracePanel({ entries, isRunning }: {
  entries: AgentTraceEntry[]
  isRunning: boolean
}) {
  if (!entries.length && !isRunning) return null
  const tools = entries.filter((entry): entry is AgentActivity => entry.type === 'tool')
  const completedCount = tools.filter((activity) => activity.status === 'complete').length
  return <details className="group rounded-xl border border-zinc-800 bg-zinc-900/45 text-xs" open={isRunning}>
    <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-zinc-300">
      <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-not-open:-rotate-90" />
      {isRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-300" /> : <Brain className="h-3.5 w-3.5 text-violet-300" />}
      <span className="font-medium">{isRunning ? 'Thinking and working' : 'Thinking and tool activity'}</span>
      {!!tools.length && <span className="text-zinc-500">{completedCount}/{tools.length} tools</span>}
    </summary>
    <div className="space-y-3 border-t border-zinc-800 px-3 py-3 text-zinc-400">
      {!entries.length && isRunning && <div className="flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin text-violet-300" /><span>Waiting for the model’s first event…</span></div>}
      {entries.map((entry) => entry.type === 'reasoning'
        ? <details key={entry.key} className="rounded-lg border border-violet-500/15 bg-violet-500/5" open>
            <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-2 text-zinc-300"><Brain className="h-3.5 w-3.5 text-violet-300" />Reasoning</summary>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-violet-500/10 px-2.5 py-2 font-sans text-xs leading-relaxed text-zinc-300">{entry.content}</pre>
          </details>
        : <details key={entry.key} className="rounded-lg border border-zinc-800 bg-zinc-950/40" open={entry.status === 'running'}>
        <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-2 text-zinc-300">
          {entry.status === 'running'
            ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-300" />
            : <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />}
          <Wrench className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <span className="min-w-0 truncate">{entry.label}</span>
        </summary>
        <div className="space-y-2 border-t border-zinc-800 px-2.5 py-2">
          <p className="font-mono text-[10px] text-zinc-500">{entry.name}</p>
          {entry.context && <p className="text-zinc-400">{entry.context}</p>}
          {entry.args && <div><p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">Input</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-900 p-2 font-mono text-[10px] leading-relaxed text-zinc-300">{entry.args}</pre></div>}
          {entry.summary && <p className="text-zinc-300">{entry.summary}</p>}
          {entry.result && <details><summary className="cursor-pointer text-zinc-500">Output</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-zinc-900 p-2 font-mono text-[10px] leading-relaxed text-zinc-300">{entry.result}</pre></details>}
        </div>
      </details>)}
    </div>
  </details>
}

function readSessionInfo(value: unknown): SessionInfo {
  if (!value || typeof value !== 'object') return {}
  const info = value as Record<string, unknown>
  return {
    model: typeof info.model === 'string' ? info.model : undefined,
    provider: typeof info.provider === 'string' ? info.provider : undefined,
  }
}

/** Structured, project-scoped Hermes chat. Replaces the ANSI/xterm side panel. */
export const SclipTerminalPanel = memo(function SclipTerminalPanel({ projectId, onClose }: SclipTerminalPanelProps) {
  const socketRef = useRef<WebSocket | null>(null)
  const rpcIdRef = useRef(0)
  const rpcCallbacksRef = useRef(new Map<string, PendingRequest>())
  const reconnectTimerRef = useRef<number | null>(null)
  const activeAssistantIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isStarting, setIsStarting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionInfo, setSessionInfo] = useState<SessionInfo>({})
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [trace, setTrace] = useState<AgentTraceEntry[]>([])
  const [input, setInput] = useState('')
  const [isRunning, setIsRunning] = useState(false)

  const rpc = useCallback((method: string, params: Record<string, unknown> = {}, timeoutMs = 45_000) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('SCLIP agent is not connected'))
    }
    const id = String(++rpcIdRef.current)
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return new Promise<any>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        rpcCallbacksRef.current.delete(id)
        reject(new Error(`The SCLIP agent did not finish ${method} within ${Math.round(timeoutMs / 1000)} seconds`))
      }, timeoutMs)
      rpcCallbacksRef.current.set(id, { resolve, reject, timeoutId })
    })
  }, [])

  const applySessionResult = useCallback((result: any) => {
    setSessionId(String(result.session_id))
    setMessages(historyToMessages(result.messages))
    setSessionInfo(readSessionInfo(result.info))
    setIsRunning(Boolean(result.running))
  }, [])

  const beginSession = useCallback(async () => {
    const latest = await rpc('session.most_recent')
    const storedSessionId = latest?.session_id
    const result = storedSessionId
      ? await rpc('session.resume', { session_id: storedSessionId, source: 'desktop', cols: 80 }, 90_000)
      : await rpc('session.create', { source: 'desktop', cols: 80 }, 90_000)
    applySessionResult(result)
  }, [applySessionResult, rpc])

  const handleFrame = useCallback((frame: GatewayFrame) => {
    if (frame.id !== undefined) {
      const callback = rpcCallbacksRef.current.get(String(frame.id))
      if (!callback) return
      rpcCallbacksRef.current.delete(String(frame.id))
      window.clearTimeout(callback.timeoutId)
      if (frame.error) callback.reject(new Error(frame.error.message || 'Agent request failed'))
      else callback.resolve(frame.result)
      return
    }
    if (frame.method !== 'event' || !frame.params?.type) return
    const { type, payload = {} } = frame.params
    if (type === 'session.info') {
      setSessionInfo(readSessionInfo(payload))
    } else if (type === 'message.start') {
      const id = `assistant-${Date.now()}`
      activeAssistantIdRef.current = id
      setMessages((current) => [...current, { id, role: 'assistant', content: '' }])
      setTrace([])
      setIsRunning(true)
    } else if (type === 'message.delta') {
      const text = textContent(payload.text)
      const id = activeAssistantIdRef.current
      if (id && text) {
        setMessages((current) => current.map((message) =>
          message.id === id ? { ...message, content: message.content + text } : message,
        ))
      }
    } else if (type === 'thinking.delta' || type === 'reasoning.delta') {
      const text = textContent(payload.text)
      if (text) setTrace((current) => {
        const last = current.at(-1)
        if (last?.type === 'reasoning') {
          return [...current.slice(0, -1), { ...last, content: last.content + text }]
        }
        return [...current, { key: `reasoning:${Date.now()}:${current.length}`, type: 'reasoning', content: text }]
      })
    } else if (type === 'tool.generating') {
      // This is only a provider-side preparation signal. The following tool.start
      // carries the real call ID, so keep the trace chronological without adding
      // a duplicate pseudo-tool card.
    } else if (type === 'tool.start' || type === 'tool.complete') {
      const name = textContent(payload.name) || 'editor_tool'
      const requestKey = textContent(payload.tool_id) || textContent(payload.tool_call_id) || textContent(payload.id) || name
      const status = type === 'tool.start' ? 'running' : 'complete'
      const args = stringifyActivityValue(payload.args)
      const result = stringifyActivityValue(payload.result)
      const summary = textContent(payload.summary)
      const context = textContent(payload.context) || textContent(payload.preview)
      setTrace((current) => {
        const index = current.findIndex((entry) => entry.type === 'tool' && entry.key === requestKey)
        if (index < 0) return [...current, {
          key: requestKey,
          type: 'tool',
          name,
          label: friendlyToolLabel(name),
          status,
          args,
          result,
          summary: summary || undefined,
          context: context || undefined,
        }]
        return current.map((activity, activityIndex) =>
          activityIndex === index
            ? {
                ...activity,
                status,
                args: args ?? activity.args,
                result: result ?? activity.result,
                summary: summary || activity.summary,
                context: context || activity.context,
              }
            : activity,
        )
      })
    } else if (type === 'message.complete') {
      const finalText = textContent(payload.text)
      const id = activeAssistantIdRef.current
      if (id && finalText) {
        setMessages((current) => current.map((message) =>
          message.id === id ? { ...message, content: finalText } : message,
        ))
      }
      activeAssistantIdRef.current = null
      setTrace((current) => current.map((entry) => entry.type === 'tool' ? { ...entry, status: 'complete' } : entry))
      setIsRunning(false)
    } else if (type === 'error') {
      setError(textContent(payload.message) || 'SCLIP agent failed to complete the request')
      activeAssistantIdRef.current = null
      setIsRunning(false)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let attempts = 0
    setIsStarting(true)
    setIsConnected(false)
    setError(null)
    setSessionId(null)
    setSessionInfo({})
    setMessages([])
    setTrace([])
    const connect = async () => {
      try {
        const gateway = await invoke<GatewayConnection>('get_sclip_agent_gateway', { projectId })
        if (disposed) return
        const socket = new WebSocket(gateway.url)
        socketRef.current = socket
        socket.onopen = () => {
          if (disposed) return
          setIsConnected(true)
          setIsStarting(false)
          setError(null)
          void beginSession().catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not open project chat'))
        }
        socket.onmessage = (event) => {
          try { handleFrame(JSON.parse(String(event.data)) as GatewayFrame) }
          catch { /* Ignore malformed diagnostics. */ }
        }
        socket.onerror = () => setError('Could not connect to the SCLIP agent')
        socket.onclose = () => {
          if (disposed) return
          setIsConnected(false)
          if (attempts++ < 40) {
            reconnectTimerRef.current = window.setTimeout(() => void connect(), 250)
          } else {
            setIsStarting(false)
            setError('Could not connect to this project’s local Hermes agent. Open Settings → AI once the connection recovers.')
          }
        }
      } catch (cause) {
        setIsStarting(false)
        setError(cause instanceof Error ? cause.message : 'Could not start SCLIP agent')
      }
    }
    void connect()
    return () => {
      disposed = true
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current)
      socketRef.current?.close()
      socketRef.current = null
      for (const request of rpcCallbacksRef.current.values()) {
        window.clearTimeout(request.timeoutId)
        request.reject(new Error('Project chat closed'))
      }
      rpcCallbacksRef.current.clear()
    }
  }, [beginSession, handleFrame, projectId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, trace])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || !sessionId || isRunning) return
    setInput('')
    setError(null)
    setTrace([])
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: 'user', content: text }])
    setIsRunning(true)
    try {
      await rpc('prompt.submit', { session_id: sessionId, text, surface: 'desktop' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send message')
      setIsRunning(false)
    }
  }, [input, isRunning, rpc, sessionId])

  const newChat = useCallback(async () => {
    if (sessionId) await rpc('session.close', { session_id: sessionId }).catch(() => undefined)
    setMessages([])
    setTrace([])
    setSessionId(null)
    setError(null)
    try {
      const result = await rpc('session.create', { source: 'desktop', cols: 80 }, 90_000)
      applySessionResult(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start a new chat')
    }
  }, [applySessionResult, rpc, sessionId])

  const interrupt = useCallback(() => {
    if (sessionId) void rpc('session.interrupt', { session_id: sessionId }).catch(() => undefined)
  }, [rpc, sessionId])

  const lastUserIndex = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === 'user') return index
    }
    return -1
  }, [messages])

  const modelLabel = [sessionInfo.provider, sessionInfo.model].filter(Boolean).join(' · ')

  return <aside className="flex h-full w-[400px] max-w-[42vw] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950 text-zinc-100" aria-label="SCLIP AI assistant">
    <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 shrink-0 text-violet-300" />
          <span className="text-sm font-medium">SCLIP</span>
          <span className={cn('h-2 w-2 shrink-0 rounded-full', isConnected ? 'bg-emerald-400' : 'animate-pulse bg-amber-400')} aria-label={isConnected ? 'Connected' : 'Connecting'} />
        </div>
        {modelLabel && <p className="mt-0.5 max-w-[240px] truncate pl-6 text-[10px] text-zinc-500" title={modelLabel}>{modelLabel}</p>}
      </div>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => void newChat()} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Start a new project chat" aria-label="Start new chat"><Plus className="h-4 w-4" /></button>
        <button type="button" onClick={() => void copyEditorDiagnosticReport().then(() => toast.success('Diagnostic report copied')).catch(() => toast.error('Could not copy diagnostic report'))} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Copy diagnostic report" aria-label="Copy diagnostic report"><Clipboard className="h-4 w-4" /></button>
        {onClose && <button type="button" onClick={onClose} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" aria-label="Close SCLIP AI"><X className="h-4 w-4" /></button>}
      </div>
    </header>
    <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-5">
      {isStarting && <div className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Opening this project’s agent…</div>}
      {!isStarting && messages.length === 0 && !error && <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4 text-sm text-zinc-300"><p className="font-medium text-zinc-100">Edit with SCLIP</p><p className="mt-1.5 text-xs leading-relaxed text-zinc-400">Ask about any imported media, timeline item, property, or edit. SCLIP reads the live project through FreeCut’s editor tools.</p></div>}
      {messages.map((message, index) => <div key={message.id}>
        <div className={cn('text-sm leading-7', message.role === 'user' ? 'ml-10 rounded-2xl rounded-br-md bg-violet-600 px-3.5 py-2 text-white' : 'px-1 text-zinc-200')}>
          {message.role === 'assistant'
            ? message.content
              ? <MarkdownMessage content={message.content} />
              : isRunning && index === messages.length - 1
                ? <span className="flex items-center gap-2 text-zinc-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />Composing response…</span>
                : null
            : <p className="whitespace-pre-wrap">{message.content}</p>}
        </div>
        {index === lastUserIndex && <div className="mt-3"><AgentTracePanel entries={trace} isRunning={isRunning} /></div>}
      </div>)}
      {lastUserIndex < 0 && <AgentTracePanel entries={trace} isRunning={isRunning} />}
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs leading-relaxed text-red-200">{error}</div>}
    </div>
    <form className="border-t border-zinc-800 p-3" onSubmit={(event) => { event.preventDefault(); void send() }}>
      <div className="flex items-end gap-2 rounded-xl border border-zinc-700 bg-zinc-900 p-2 focus-within:border-violet-400">
        <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} placeholder="Ask SCLIP to inspect or edit this project…" rows={2} disabled={!isConnected || !sessionId} className="min-h-[52px] flex-1 resize-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-zinc-500 disabled:opacity-50" />
        {isRunning
          ? <button type="button" onClick={interrupt} className="rounded-lg border border-zinc-700 p-2.5 text-zinc-200 hover:bg-zinc-800" aria-label="Stop agent"><Square className="h-4 w-4" /></button>
          : <button type="submit" disabled={!input.trim() || !isConnected || !sessionId} className="rounded-lg bg-violet-600 p-2.5 text-white hover:bg-violet-500 disabled:opacity-40" aria-label="Send message"><Send className="h-4 w-4" /></button>}
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">Project-private chat saved locally. Change the active LLM in Settings → AI.</p>
    </form>
  </aside>
})

SclipTerminalPanel.displayName = 'SclipTerminalPanel'
