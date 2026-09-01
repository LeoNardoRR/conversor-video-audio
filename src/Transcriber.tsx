import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  AudioLines,
  Check,
  Clipboard,
  Download,
  FileAudio2,
  Languages,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react'

type TranscriptionStatus = 'idle' | 'ready' | 'uploading' | 'transcribing' | 'success' | 'error'
type TranscriptionJob = {
  id: string
  status: 'uploading' | 'queued' | 'transcribing' | 'ready' | 'error'
  progress: number
  stage: 'uploading' | 'queued' | 'preparing' | 'recognizing' | 'complete' | 'error'
  language: string
  detected_language?: string
  error?: string
  output_name?: string
  output_size?: number
  character_count?: number
  text?: string
  download_url?: string
}

const audioExtensions = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'wma', 'webm']
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

const stageLabels: Record<TranscriptionJob['stage'], string> = {
  uploading: 'Enviando o áudio para a VPS',
  queued: 'Aguardando a fila de processamento',
  preparing: 'Preparando e normalizando o áudio',
  recognizing: 'Reconhecendo as falas com IA local',
  complete: 'Transcrição concluída',
  error: 'A transcrição não foi concluída',
}

export default function Transcriber() {
  const inputRef = useRef<HTMLInputElement>(null)
  const uploadRef = useRef<XMLHttpRequest | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [duration, setDuration] = useState(0)
  const [language, setLanguage] = useState('auto')
  const [status, setStatus] = useState<TranscriptionStatus>('idle')
  const [stage, setStage] = useState<TranscriptionJob['stage']>('uploading')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [jobId, setJobId] = useState('')
  const [text, setText] = useState('')
  const [outputName, setOutputName] = useState('transcricao.txt')
  const [copied, setCopied] = useState(false)

  const busy = status === 'uploading' || status === 'transcribing'
  const selectedLanguage = languageOptions.find((item) => item.value === language)!

  useEffect(() => () => {
    uploadRef.current?.abort()
    if (audioUrl) URL.revokeObjectURL(audioUrl)
  }, [audioUrl])

  function selectFile(nextFile?: File) {
    if (!nextFile || busy) return
    const extension = nextFile.name.split('.').pop()?.toLowerCase() || ''
    if (!nextFile.type.startsWith('audio/') && !audioExtensions.includes(extension)) {
      setError('Esse arquivo não parece ser um áudio compatível. Tente MP3, WAV, M4A, OGG ou FLAC.')
      setStatus('error')
      return
    }
    if (!nextFile.size) {
      setError('O arquivo está vazio. Escolha outro áudio para continuar.')
      setStatus('error')
      return
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setFile(nextFile)
    setAudioUrl(URL.createObjectURL(nextFile))
    setDuration(0)
    setText('')
    setJobId('')
    setProgress(0)
    setError('')
    setStatus('ready')
  }

  async function clearFile() {
    if (busy) return
    if (jobId) fetch(`/api/transcriptions/${jobId}`, { method: 'DELETE' }).catch(() => undefined)
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setFile(null)
    setAudioUrl('')
    setDuration(0)
    setText('')
    setJobId('')
    setProgress(0)
    setError('')
    setStatus('idle')
    if (inputRef.current) inputRef.current.value = ''
  }

  function uploadAudio(audio: File) {
    return new Promise<TranscriptionJob>((resolve, reject) => {
      const request = new XMLHttpRequest()
      uploadRef.current = request
      request.open('POST', `/api/transcriptions?language=${encodeURIComponent(language)}`)
      request.responseType = 'json'
      request.setRequestHeader('Content-Type', audio.type || 'application/octet-stream')
      request.setRequestHeader('X-Filename', encodeURIComponent(audio.name))
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 30))
      }
      request.onload = () => {
        uploadRef.current = null
        if (request.status >= 200 && request.status < 300) resolve(request.response as TranscriptionJob)
        else reject(new Error(request.response?.detail || 'A VPS recusou o envio do áudio.'))
      }
      request.onerror = () => reject(new Error('A conexão foi interrompida durante o upload.'))
      request.onabort = () => reject(new Error('O upload foi cancelado.'))
      request.send(audio)
    })
  }

  async function waitForJob(id: string) {
    while (true) {
      const response = await fetch(`/api/transcriptions/${id}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('Não foi possível consultar o andamento da transcrição.')
      const job = await response.json() as TranscriptionJob
      setStage(job.stage)
      setProgress((current) => job.stage === 'recognizing'
        ? Math.min(92, Math.max(current + 1, 42))
        : Math.max(current, job.progress))
      if (job.status === 'ready') return job
      if (job.status === 'error') throw new Error(job.error || 'A transcrição falhou na VPS.')
      await new Promise((resolve) => window.setTimeout(resolve, 1600))
    }
  }

  async function transcribe() {
    if (!file || busy) return
    setError('')
    setText('')
    setStage('uploading')
    setProgress(1)
    setStatus('uploading')
    try {
      const queued = await uploadAudio(file)
      setJobId(queued.id)
      setStage(queued.stage)
      setStatus('transcribing')
      setProgress(32)
      const result = await waitForJob(queued.id)
      setText(result.text?.trim() || '')
      setOutputName(result.output_name || 'transcricao.txt')
      setProgress(100)
      setStage('complete')
      setStatus('success')
    } catch (transcriptionError) {
      setError(transcriptionError instanceof Error ? transcriptionError.message : 'Não foi possível transcrever o áudio.')
      setProgress(0)
      setStage('error')
      setStatus('error')
    }
  }

  async function copyText() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  function downloadText() {
    const blob = new Blob([text.trim() + '\n'], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = outputName
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="transcriber-page" id="audio-texto">
      <section className="transcriber-hero">
        <div>
          <div className="eyebrow"><span /> Transcrição inteligente e privada</div>
          <h1>Áudio em texto.<br /><em>Pronto para usar.</em></h1>
          <p>Envie reuniões, treinamentos e gravações. A IA roda na própria VPS e entrega um texto que você pode revisar, copiar e baixar.</p>
        </div>
        <div className="transcriber-trust">
          <ShieldCheck size={25} />
          <div><strong>IA dentro da sua VPS</strong><span>O áudio não é enviado para serviços externos de transcrição.</span></div>
        </div>
      </section>

      <section className={`transcriber-card ${file ? 'has-file' : ''}`} aria-label="Conversor de áudio para texto">
        <div className="converter-heading">
          <div><span className="heading-index">01</span><div><strong>Áudio para texto</strong><small>Envie uma gravação para começar</small></div></div>
          <span className="online-status"><i /> Whisper local</span>
        </div>
        <input ref={inputRef} className="sr-only" type="file" accept="audio/*,.wma,.opus" onChange={(event) => selectFile(event.target.files?.[0])} aria-label="Escolher arquivo de áudio" />

        {!file ? (
          <button className={`dropzone transcription-dropzone ${dragging ? 'is-dragging' : ''}`} type="button" onClick={() => inputRef.current?.click()}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { event.preventDefault(); setDragging(false) }} onDrop={(event) => { event.preventDefault(); setDragging(false); selectFile(event.dataTransfer.files?.[0]) }}>
            <span className="upload-icon"><UploadCloud size={30} strokeWidth={1.7} /></span>
            <strong>{dragging ? 'Pode soltar o áudio' : 'Arraste seu áudio para cá'}</strong>
            <span>ou <b>escolha um arquivo</b> no seu dispositivo</span>
            <small><i /> MP3, WAV, M4A, AAC, OGG, FLAC, OPUS e WMA</small>
          </button>
        ) : (
          <div className="transcription-workspace">
            <aside className="transcription-sidebar">
              <div className="audio-preview">
                <span><AudioLines size={34} /></span>
                <strong>Prévia do áudio</strong>
                <audio src={audioUrl} controls preload="metadata" onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} />
              </div>
              <div className="file-summary">
                <span className="file-icon"><FileAudio2 size={20} /></span>
                <div className="file-copy"><strong title={file.name}>{file.name}</strong><span>{formatBytes(file.size)} · {formatDuration(duration)}</span></div>
                <button className="icon-button" type="button" onClick={clearFile} disabled={busy} aria-label="Remover áudio"><X size={18} /></button>
              </div>
              <div className="transcription-setting">
                <div className="step-heading"><span>02</span><div><strong>Idioma da gravação</strong><small>Ajuda a IA a reconhecer melhor</small></div></div>
                <label className="language-select"><Languages size={18} /><span><strong>{selectedLanguage.label}</strong><small>{selectedLanguage.hint}</small></span><select value={language} onChange={(event) => setLanguage(event.target.value)} disabled={busy}>{languageOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              </div>
              {status !== 'success' && <button className="convert-button" type="button" onClick={transcribe} disabled={busy}><Sparkles size={17} />{busy ? 'Transcrevendo…' : 'Transcrever áudio'}</button>}
              {busy && <div className="progress-card"><div><span>{stageLabels[stage]}</span><strong>{progress}%</strong></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div><small>Áudios longos podem levar alguns minutos. Você pode manter esta aba aberta.</small></div>}
              {error && <div className="error-message"><AlertCircle size={17} /><span>{error}</span></div>}
            </aside>

            <div className={`transcript-panel ${status === 'success' ? 'has-transcript' : ''}`}>
              {status === 'success' ? <>
                <div className="transcript-heading"><div><span className="success-icon"><Check size={19} /></span><div><small>Transcrição concluída</small><strong>{text.length.toLocaleString('pt-BR')} caracteres</strong></div></div><div><button type="button" onClick={copyText}><Clipboard size={15} />{copied ? 'Copiado' : 'Copiar'}</button><button type="button" onClick={downloadText}><Download size={15} />Baixar TXT</button></div></div>
                <textarea value={text} onChange={(event) => setText(event.target.value)} aria-label="Texto transcrito" spellCheck />
                <div className="transcript-footer"><span>Revise nomes próprios, números e termos técnicos antes de usar.</span><button type="button" onClick={clearFile}><RefreshCw size={13} />Nova transcrição</button></div>
              </> : <div className="transcript-empty"><span>{busy ? <LoaderCircle className="spinning" size={32} /> : <AudioLines size={32} />}</span><strong>{busy ? stageLabels[stage] : 'O texto aparecerá aqui'}</strong><p>{busy ? 'A VPS está processando o áudio com o modelo de reconhecimento local.' : 'Depois da transcrição, você poderá corrigir o conteúdo, copiar tudo ou baixar um arquivo TXT.'}</p><div><span><Check size={12} /> Texto editável</span><i /><span><Check size={12} /> Download em TXT</span></div></div>}
            </div>
          </div>
        )}
        {!file && <div className="format-row"><span>Processamento local na VPS</span><div><span className="format-pill">IA LOCAL</span><span className="format-pill">TXT</span><span className="format-pill">MULTILÍNGUE</span></div></div>}
      </section>
    </div>
  )
}
