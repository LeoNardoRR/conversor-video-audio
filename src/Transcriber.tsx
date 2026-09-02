import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  AudioLines,
  Check,
  Clipboard,
  Clock3,
  Download,
  FileAudio2,
  FileVideo2,
  History,
  Languages,
  ListVideo,
  LoaderCircle,
  PauseCircle,
  RefreshCw,
  Sparkles,
  UploadCloud,
  Users,
  X,
} from 'lucide-react'

type TranscriptionStatus = 'idle' | 'ready' | 'uploading' | 'transcribing' | 'success' | 'error'
type DownloadFormat = 'txt' | 'doc' | 'md' | 'srt' | 'vtt'
type Segment = { id: number; start: number; end: number; text: string; speaker?: '0' | '1' | '?' }
type TranscriptionJob = {
  id: string
  status: 'uploading' | 'queued' | 'transcribing' | 'ready' | 'error' | 'cancelled'
  progress: number
  stage: 'uploading' | 'queued' | 'preparing' | 'recognizing' | 'complete' | 'error' | 'cancelled'
  language: string
  detected_language?: string
  error?: string
  original_name: string
  input_size: number
  expected_size?: number
  duration_seconds?: number
  estimated_seconds?: number
  speaker_detection?: boolean
  timestamps?: boolean
  speaker_detection_status?: 'identified' | 'unavailable'
  output_name?: string
  output_size?: number
  character_count?: number
  text?: string
  segments?: Segment[]
  download_url?: string
  created_at: number
  updated_at: number
}
type HistoryEntry = Pick<TranscriptionJob, 'id' | 'original_name' | 'status' | 'created_at' | 'updated_at'>
type UploadSession = { id: string; name: string; size: number; lastModified: number }

const HISTORY_KEY = 'media-tools-transcription-history-v2'
const UPLOAD_KEY = 'media-tools-resumable-upload-v2'
const CHUNK_SIZE = 8 * 1024 * 1024

const audioExtensions = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'wma', 'webm']
const videoExtensions = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'mpeg', 'mpg']
const languageOptions = [
  { value: 'auto', label: 'Detectar automaticamente', hint: 'Melhor para a maioria dos áudios' },
  { value: 'pt', label: 'Português', hint: 'Prioriza falas em português' },
  { value: 'en', label: 'Inglês', hint: 'Prioriza falas em inglês' },
  { value: 'es', label: 'Espanhol', hint: 'Prioriza falas em espanhol' },
]

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Duração não identificada'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = Math.floor(seconds % 60)
  return hours
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${rest.toString().padStart(2, '0')}`
    : `${minutes}:${rest.toString().padStart(2, '0')}`
}

function formatEstimatedTime(seconds: number) {
  if (seconds < 60) return `${Math.max(5, Math.round(seconds / 5) * 5)} s`
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

function transcriptionEstimate(duration: number, serverEstimate?: number) {
  if (serverEstimate) return `aprox. ${formatEstimatedTime(serverEstimate)}`
  if (!duration) return 'Disponível após identificarmos a duração'
  const minimum = Math.max(5, duration * 0.25)
  const maximum = Math.max(10, duration * 0.45)
  return `${formatEstimatedTime(minimum)}–${formatEstimatedTime(maximum)}`
}

const stageLabels: Record<TranscriptionJob['stage'], string> = {
  uploading: 'Enviando o arquivo para a VPS',
  queued: 'Aguardando a fila de processamento',
  preparing: 'Extraindo e preparando o áudio',
  recognizing: 'Reconhecendo as falas com IA local',
  complete: 'Transcrição concluída',
  error: 'A transcrição não foi concluída',
  cancelled: 'Transcrição cancelada',
}

function historyStatus(status: HistoryEntry['status']) {
  return { uploading: 'Upload pausado', queued: 'Na fila', transcribing: 'Processando', ready: 'Concluída', error: 'Falhou', cancelled: 'Cancelada' }[status]
}

function subtitleTimestamp(seconds: number, separator = ',') {
  const milliseconds = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000)
  const secs = Math.floor(milliseconds % 60_000 / 1000)
  const millis = milliseconds % 1000
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}${separator}${millis.toString().padStart(3, '0')}`
}

function speakerName(speaker?: string) {
  return speaker === '0' ? 'Participante 1' : speaker === '1' ? 'Participante 2' : ''
}

async function responseError(response: Response, fallback: string) {
  try {
    const payload = await response.json()
    const detail = payload.detail
    return typeof detail === 'string' ? detail : detail?.message || fallback
  } catch { return fallback }
}

export default function Transcriber() {
  const inputRef = useRef<HTMLInputElement>(null)
  const uploadController = useRef<AbortController | null>(null)
  const activeJobId = useRef('')
  const [file, setFile] = useState<File | null>(null)
  const [sourceName, setSourceName] = useState('')
  const [sourceSize, setSourceSize] = useState(0)
  const [audioUrl, setAudioUrl] = useState('')
  const [duration, setDuration] = useState(0)
  const [serverEstimate, setServerEstimate] = useState<number>()
  const [language, setLanguage] = useState('auto')
  const [timestamps, setTimestamps] = useState(true)
  const [speakerDetection, setSpeakerDetection] = useState(false)
  const [speakerStatus, setSpeakerStatus] = useState<TranscriptionJob['speaker_detection_status']>()
  const [status, setStatus] = useState<TranscriptionStatus>('idle')
  const [stage, setStage] = useState<TranscriptionJob['stage']>('uploading')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [jobId, setJobId] = useState('')
  const [text, setText] = useState('')
  const [segments, setSegments] = useState<Segment[]>([])
  const [downloadName, setDownloadName] = useState('transcricao')
  const [downloadFormat, setDownloadFormat] = useState<DownloadFormat>('txt')
  const [copied, setCopied] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') as HistoryEntry[] } catch { return [] }
  })
  const [loadingHistory, setLoadingHistory] = useState(false)

  const busy = status === 'uploading' || status === 'transcribing'
  const selectedLanguage = languageOptions.find((item) => item.value === language)!
  const selectedExtension = (file?.name || sourceName).split('.').pop()?.toLowerCase() || ''
  const isVideo = Boolean(file?.type.startsWith('video/') || videoExtensions.includes(selectedExtension))
  const estimatedTime = transcriptionEstimate(duration, serverEstimate)
  const hasWorkspace = Boolean(file || status === 'success')

  useEffect(() => () => {
    uploadController.current?.abort()
    if (audioUrl) URL.revokeObjectURL(audioUrl)
  }, [audioUrl])

  function storeHistory(entries: HistoryEntry[]) {
    const unique = entries.filter((entry, index) => entries.findIndex((item) => item.id === entry.id) === index).slice(0, 10)
    setHistory(unique)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(unique))
  }

  function rememberJob(job: TranscriptionJob) {
    setHistory((current) => {
      const entry: HistoryEntry = { id: job.id, original_name: job.original_name, status: job.status, created_at: job.created_at, updated_at: job.updated_at }
      const next = [entry, ...current.filter((item) => item.id !== job.id)].slice(0, 10)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
      return next
    })
  }

  useEffect(() => {
    let stored: HistoryEntry[] = []
    try { stored = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') as HistoryEntry[] } catch { stored = [] }
    Promise.all(stored.map(async (entry) => {
      try {
        const response = await fetch(`/api/transcriptions/${entry.id}`, { cache: 'no-store' })
        return response.ok ? await response.json() as TranscriptionJob : null
      } catch { return entry }
    })).then((items) => {
      const valid = items.filter(Boolean) as (TranscriptionJob | HistoryEntry)[]
      storeHistory(valid.map((item) => ({ id: item.id, original_name: item.original_name, status: item.status, created_at: item.created_at, updated_at: item.updated_at })))
    })
  }, [])

  function selectFile(nextFile?: File) {
    if (!nextFile || busy) return
    const extension = nextFile.name.split('.').pop()?.toLowerCase() || ''
    const supportedAudio = nextFile.type.startsWith('audio/') || audioExtensions.includes(extension)
    const supportedVideo = nextFile.type.startsWith('video/') || videoExtensions.includes(extension)
    if (!supportedAudio && !supportedVideo) {
      setError('Esse arquivo não parece ser um áudio ou vídeo compatível. Tente MP3, WAV, M4A, MP4, MOV ou WebM.')
      setStatus('error')
      return
    }
    if (!nextFile.size) {
      setError('O arquivo está vazio. Escolha outra mídia para continuar.')
      setStatus('error')
      return
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setFile(nextFile)
    setSourceName(nextFile.name)
    setSourceSize(nextFile.size)
    setAudioUrl(URL.createObjectURL(nextFile))
    setDuration(0)
    setServerEstimate(undefined)
    setText('')
    setSegments([])
    setSpeakerStatus(undefined)
    setDownloadName(`${nextFile.name.replace(/\.[^.]+$/, '')}-transcricao`)
    setJobId('')
    activeJobId.current = ''
    setProgress(0)
    setError('')
    setStatus('ready')
  }

  function clearFile() {
    if (busy) return
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setFile(null)
    setSourceName('')
    setSourceSize(0)
    setAudioUrl('')
    setDuration(0)
    setServerEstimate(undefined)
    setText('')
    setSegments([])
    setSpeakerStatus(undefined)
    setDownloadName('transcricao')
    setJobId('')
    activeJobId.current = ''
    setProgress(0)
    setError('')
    setStatus('idle')
    if (inputRef.current) inputRef.current.value = ''
  }

  async function createOrResumeUpload(audio: File) {
    let job: TranscriptionJob | undefined
    try {
      const session = JSON.parse(localStorage.getItem(UPLOAD_KEY) || 'null') as UploadSession | null
      if (session && session.name === audio.name && session.size === audio.size && session.lastModified === audio.lastModified) {
        const response = await fetch(`/api/transcriptions/${session.id}`, { cache: 'no-store' })
        if (response.ok) {
          const candidate = await response.json() as TranscriptionJob
          if (['uploading', 'queued', 'transcribing', 'ready'].includes(candidate.status)) job = candidate
        }
      }
    } catch { localStorage.removeItem(UPLOAD_KEY) }

    if (!job) {
      const response = await fetch('/api/transcription-uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ original_name: audio.name, size: audio.size, language, timestamps, speaker_detection: speakerDetection, last_modified: audio.lastModified }),
      })
      if (!response.ok) throw new Error(await responseError(response, 'A VPS não conseguiu iniciar o upload.'))
      job = await response.json() as TranscriptionJob
      localStorage.setItem(UPLOAD_KEY, JSON.stringify({ id: job.id, name: audio.name, size: audio.size, lastModified: audio.lastModified }))
    }

    setJobId(job.id)
    activeJobId.current = job.id
    rememberJob(job)
    if (job.status !== 'uploading') return job

    let offset = job.input_size || 0
    const controller = new AbortController()
    uploadController.current = controller
    while (offset < audio.size) {
      const chunk = audio.slice(offset, Math.min(offset + CHUNK_SIZE, audio.size))
      let response: Response | undefined
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          response = await fetch(`/api/transcription-uploads/${job.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset) }, body: chunk, signal: controller.signal })
          if (response.ok) break
          if (response.status === 409) {
            const current = await fetch(`/api/transcriptions/${job.id}`, { cache: 'no-store' })
            if (current.ok) { job = await current.json() as TranscriptionJob; offset = job.input_size; response = undefined; break }
          }
        } catch (uploadError) {
          if (controller.signal.aborted) throw uploadError
        }
        await new Promise((resolve) => window.setTimeout(resolve, 700 * (attempt + 1)))
      }
      if (!response?.ok) throw new Error('O upload foi pausado. Clique novamente em transcrever para continuar do ponto salvo.')
      job = await response.json() as TranscriptionJob
      offset = job.input_size
      setProgress(Math.round(offset / audio.size * 100))
      rememberJob(job)
    }
    uploadController.current = null
    const complete = await fetch(`/api/transcription-uploads/${job.id}/complete`, { method: 'POST' })
    if (!complete.ok) throw new Error(await responseError(complete, 'A VPS não conseguiu finalizar o upload.'))
    job = await complete.json() as TranscriptionJob
    localStorage.removeItem(UPLOAD_KEY)
    rememberJob(job)
    return job
  }

  async function waitForJob(id: string) {
    while (true) {
      const response = await fetch(`/api/transcriptions/${id}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('Não foi possível consultar o andamento da transcrição.')
      const job = await response.json() as TranscriptionJob
      rememberJob(job)
      setStage(job.stage)
      if (job.duration_seconds) setDuration(job.duration_seconds)
      if (job.estimated_seconds) setServerEstimate(job.estimated_seconds)
      if (job.status === 'ready') return job
      if (job.status === 'cancelled') throw new Error('Transcrição cancelada.')
      if (job.status === 'error') throw new Error(job.error || 'A transcrição falhou na VPS.')
      await new Promise((resolve) => window.setTimeout(resolve, 1600))
    }
  }

  async function transcribe() {
    if (!file || busy) return
    setError('')
    setText('')
    setStage('uploading')
    setProgress(0)
    setStatus('uploading')
    try {
      const queued = await createOrResumeUpload(file)
      if (queued.status === 'ready') { showResult(queued); return }
      setStage(queued.stage)
      setStatus('transcribing')
      showResult(await waitForJob(queued.id))
    } catch (transcriptionError) {
      const message = transcriptionError instanceof Error ? transcriptionError.message : 'Não foi possível transcrever este arquivo.'
      setError(message)
      setProgress(0)
      setStage(message.toLowerCase().includes('cancel') ? 'cancelled' : 'error')
      setStatus(file ? 'ready' : 'error')
    }
  }

  function showResult(result: TranscriptionJob) {
    setSourceName(result.original_name)
    setSourceSize(result.input_size)
    setDuration(result.duration_seconds || duration)
    setServerEstimate(result.estimated_seconds)
    setText(result.text?.trim() || '')
    setSegments(result.segments || [])
    setSpeakerDetection(Boolean(result.speaker_detection))
    setTimestamps(result.timestamps ?? true)
    setSpeakerStatus(result.speaker_detection_status)
    setDownloadName((result.output_name || 'transcricao.txt').replace(/\.[^.]+$/, ''))
    setProgress(100)
    setStage('complete')
    setStatus('success')
  }

  async function cancelTranscription() {
    uploadController.current?.abort()
    const id = activeJobId.current || jobId
    if (id) await fetch(`/api/transcriptions/${id}/cancel`, { method: 'POST' }).catch(() => undefined)
    localStorage.removeItem(UPLOAD_KEY)
    setStatus(file ? 'ready' : 'idle')
    setStage('cancelled')
    setError('Transcrição cancelada. Você pode iniciar novamente quando quiser.')
    setProgress(0)
  }

  async function restoreHistory(entry: HistoryEntry) {
    setLoadingHistory(true)
    setError('')
    try {
      const response = await fetch(`/api/transcriptions/${entry.id}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('Essa transcrição expirou e não está mais disponível na VPS.')
      const job = await response.json() as TranscriptionJob
      setJobId(job.id)
      activeJobId.current = job.id
      if (job.status === 'ready') showResult(job)
      else if (job.status === 'queued' || job.status === 'transcribing') {
        setStatus('transcribing')
        setStage(job.stage)
        showResult(await waitForJob(job.id))
      } else if (job.status === 'uploading') throw new Error(`Selecione novamente “${job.original_name}” para retomar o upload.`)
      else throw new Error(job.error || 'Essa transcrição não pode ser recuperada.')
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : 'Não foi possível recuperar a transcrição.')
    } finally { setLoadingHistory(false) }
  }

  async function removeHistory(entry: HistoryEntry) {
    if (!['uploading', 'queued', 'transcribing'].includes(entry.status)) await fetch(`/api/transcriptions/${entry.id}`, { method: 'DELETE' }).catch(() => undefined)
    storeHistory(history.filter((item) => item.id !== entry.id))
  }

  async function copyText() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  function downloadText() {
    const cleanName = (downloadName.trim() || 'transcricao')
      .replace(/\.(txt|doc|md|srt|vtt)$/i, '')
      .replace(/[\\/:*?"<>|]/g, '-')
      .slice(0, 120)
    let content = text.trim() + '\n'
    let mime = 'text/plain;charset=utf-8'
    if (downloadFormat === 'md') content = `# Transcrição\n\n${text.trim()}\n`
    if (downloadFormat === 'doc') {
      const escaped = text.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
      content = `<!doctype html><html><head><meta charset="utf-8"><title>${cleanName}</title><style>body{font-family:Arial,sans-serif;font-size:12pt;line-height:1.6;margin:2.5cm}</style></head><body>${escaped}</body></html>`
      mime = 'application/msword;charset=utf-8'
    }
    if (downloadFormat === 'srt') content = segments.map((segment, index) => `${index + 1}\n${subtitleTimestamp(segment.start)} --> ${subtitleTimestamp(segment.end)}\n${speakerName(segment.speaker)}${speakerName(segment.speaker) ? ': ' : ''}${segment.text}\n`).join('\n')
    if (downloadFormat === 'vtt') content = `WEBVTT\n\n${segments.map((segment) => `${subtitleTimestamp(segment.start, '.')} --> ${subtitleTimestamp(segment.end, '.')}\n${speakerName(segment.speaker)}${speakerName(segment.speaker) ? ': ' : ''}${segment.text}\n`).join('\n')}`
    const blob = new Blob(['\ufeff', content], { type: mime })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${cleanName}.${downloadFormat}`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
      <div className={`converter-flow transcriber-flow ${hasWorkspace ? 'has-file' : ''}`} id="midia-texto" role="tabpanel" aria-label="Conversor de áudio ou vídeo para texto">
        <div className="converter-heading">
          <div><span className="heading-index">01</span><div><strong>Selecione um áudio ou vídeo</strong><small>A VPS extrai a fala e entrega um texto editável</small></div></div>
          <span className="online-status"><i /> Whisper local</span>
        </div>
        {import.meta.env.DEV && <div className="dev-backend-note"><AlertCircle size={16} /><span><strong>Prévia local</strong> Para transcrever, o backend e o Whisper precisam estar ativos. A versão publicada usa esses serviços na VPS.</span></div>}
        <input ref={inputRef} className="sr-only" type="file" accept="audio/*,video/*,.wma,.opus,.mkv,.avi,.m4v" onChange={(event) => selectFile(event.target.files?.[0])} aria-label="Escolher arquivo de áudio ou vídeo" />

        {!hasWorkspace ? (
          <button className={`dropzone transcription-dropzone ${dragging ? 'is-dragging' : ''}`} type="button" onClick={() => inputRef.current?.click()}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { event.preventDefault(); setDragging(false) }} onDrop={(event) => { event.preventDefault(); setDragging(false); selectFile(event.dataTransfer.files?.[0]) }}>
            <span className="upload-icon"><UploadCloud size={30} strokeWidth={1.7} /></span>
            <strong>{dragging ? 'Pode soltar o arquivo' : 'Arraste seu áudio ou vídeo para cá'}</strong>
            <span>ou <b>escolha um arquivo</b> no seu dispositivo</span>
            <small><i /> Áudio: MP3, WAV, M4A, OGG · Vídeo: MP4, MOV, AVI, MKV, WebM</small>
          </button>
        ) : (
          <div className="transcription-workspace">
            <aside className="transcription-sidebar">
              <div className="audio-preview">
                {!file ? <><span><History size={34} /></span><strong>Resultado recuperado do histórico</strong></> : isVideo ? <video src={audioUrl} controls preload="metadata" onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} /> : <><span><AudioLines size={34} /></span><strong>Prévia do áudio</strong><audio src={audioUrl} controls preload="metadata" onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} /></>}
              </div>
              <div className="file-summary">
                <span className="file-icon">{isVideo ? <FileVideo2 size={20} /> : <FileAudio2 size={20} />}</span>
                <div className="file-copy"><strong title={sourceName}>{sourceName}</strong><span>{formatBytes(sourceSize)} · {formatDuration(duration)}</span></div>
                <button className="icon-button" type="button" onClick={clearFile} disabled={busy} aria-label="Remover áudio"><X size={18} /></button>
              </div>
              <div className="transcription-setting">
                <div className="step-heading"><span>02</span><div><strong>Idioma da gravação</strong><small>Ajuda a IA a reconhecer melhor</small></div></div>
                <label className="language-select"><Languages size={18} /><span><strong>{selectedLanguage.label}</strong><small>{selectedLanguage.hint}</small></span><select value={language} onChange={(event) => setLanguage(event.target.value)} disabled={busy}>{languageOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                <label className="transcription-toggle"><input type="checkbox" checked={timestamps} onChange={(event) => setTimestamps(event.target.checked)} disabled={busy} /><ListVideo size={17} /><span><strong>Incluir timestamps</strong><small>Marca o início de cada trecho</small></span></label>
                <label className="transcription-toggle"><input type="checkbox" checked={speakerDetection} onChange={(event) => setSpeakerDetection(event.target.checked)} disabled={busy} /><Users size={17} /><span><strong>Separar participantes (beta)</strong><small>Melhor em chamadas estéreo</small></span></label>
              </div>
              <div className="transcription-estimate"><Clock3 size={17} /><span><small>Tempo médio estimado</small><strong>{estimatedTime}</strong></span></div>
              {status !== 'success' && <button className="convert-button" type="button" onClick={transcribe} disabled={busy || !file}><Sparkles size={17} />{busy ? 'Transcrevendo…' : isVideo ? 'Transcrever vídeo' : 'Transcrever áudio'}</button>}
              {busy && <><div className="progress-card"><div><span>{stageLabels[stage]}</span><strong>{status === 'uploading' ? `${progress}%` : 'Em andamento'}</strong></div><div className={`progress-track ${status === 'transcribing' ? 'is-indeterminate' : ''}`}><i style={status === 'uploading' ? { width: `${progress}%` } : undefined} /></div><small>{status === 'uploading' ? 'Upload em blocos: se a conexão cair, selecione o mesmo arquivo para retomar.' : `Estimativa adaptativa: ${estimatedTime}.`}</small></div><button className="cancel-transcription" type="button" onClick={cancelTranscription}><PauseCircle size={16} />Cancelar processamento</button></>}
              {error && <div className="error-message"><AlertCircle size={17} /><span>{error}</span></div>}
            </aside>

            <div className={`transcript-panel ${status === 'success' ? 'has-transcript' : ''}`}>
              {status === 'success' ? <>
                <div className="transcript-heading"><div><span className="success-icon"><Check size={19} /></span><div><small>Transcrição concluída</small><strong>{text.length.toLocaleString('pt-BR')} caracteres · {segments.length} trechos</strong></div></div><div><button type="button" onClick={copyText}><Clipboard size={15} />{copied ? 'Copiado' : 'Copiar'}</button></div></div>
                {speakerDetection && speakerStatus === 'unavailable' && <div className="speaker-warning"><AlertCircle size={15} />Não foi possível separar participantes com segurança. O arquivo provavelmente não possui vozes em canais distintos.</div>}
                <textarea value={text} onChange={(event) => setText(event.target.value)} aria-label="Texto transcrito" spellCheck />
                <div className="transcript-download"><label><span>Nome do arquivo</span><input value={downloadName} onChange={(event) => setDownloadName(event.target.value)} placeholder="transcricao" /></label><label><span>Formato</span><select value={downloadFormat} onChange={(event) => setDownloadFormat(event.target.value as DownloadFormat)}><option value="txt">Texto (.txt)</option><option value="doc">Word (.doc)</option><option value="md">Markdown (.md)</option><option value="srt" disabled={!segments.length}>Legendas (.srt)</option><option value="vtt" disabled={!segments.length}>Legendas web (.vtt)</option></select></label><button type="button" onClick={downloadText}><Download size={16} />Baixar .{downloadFormat}</button></div>
                <div className="transcript-footer"><span>Revise nomes próprios, números e termos técnicos antes de usar.</span><button type="button" onClick={clearFile}><RefreshCw size={13} />Nova transcrição</button></div>
              </> : <div className="transcript-empty"><span>{busy ? <LoaderCircle className="spinning" size={32} /> : <AudioLines size={32} />}</span><strong>{busy ? stageLabels[stage] : 'O texto aparecerá aqui'}</strong><p>{busy ? 'A VPS está processando a mídia. Você pode cancelar sem perder o histórico.' : 'Depois da transcrição, você poderá editar, copiar e baixar o documento ou as legendas.'}</p><div><span><Check size={12} /> Texto editável</span><i /><span><Check size={12} /> Timestamps</span><i /><span><Check size={12} /> Histórico</span></div></div>}
            </div>
          </div>
        )}
        {history.length > 0 && <section className="transcription-history"><div className="history-heading"><div><History size={17} /><span><strong>Histórico recente</strong><small>Disponível neste navegador durante a retenção da VPS</small></span></div></div><div className="history-list">{history.map((entry) => <div key={entry.id}><button type="button" onClick={() => restoreHistory(entry)} disabled={loadingHistory}><span className={`history-status status-${entry.status}`} /><span><strong>{entry.original_name}</strong><small>{historyStatus(entry.status)} · {new Date(entry.created_at * 1000).toLocaleString('pt-BR')}</small></span></button><button type="button" onClick={() => removeHistory(entry)} aria-label={`Remover ${entry.original_name} do histórico`}><X size={15} /></button></div>)}</div></section>}
        {!hasWorkspace && <div className="format-row"><span>Áudio e vídeo processados na VPS</span><div><span className="format-pill">RETOMÁVEL</span><span className="format-pill">TXT</span><span className="format-pill">SRT</span></div></div>}
      </div>
  )
}
