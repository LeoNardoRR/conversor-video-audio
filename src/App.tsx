import { useEffect, useMemo, useRef, useState } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import coreURL from '../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js?url'
import wasmURL from '../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm?url'
import {
  AlertCircle,
  AudioWaveform,
  Check,
  Download,
  FileVideo2,
  LockKeyhole,
  RefreshCw,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react'
import './App.css'
import LeadIntel from './LeadIntel'
import Transcriber from './Transcriber'

type AudioFormat = 'mp3' | 'wav' | 'm4a' | 'ogg'
type AppStatus = 'idle' | 'ready' | 'uploading' | 'loading' | 'converting' | 'success' | 'error'
type ConversionResult = { url: string; name: string; size: number; remote?: boolean }
type ServerJob = {
  id: string
  status: 'uploading' | 'queued' | 'converting' | 'ready' | 'error'
  progress: number
  error?: string
  output_name?: string
  output_size?: number
  download_url?: string
}
type ActiveTool = 'converter' | 'company-analysis'
type ConversionMode = 'video-audio' | 'audio-text'

const serverMode = import.meta.env.VITE_CONVERSION_MODE === 'server'

const formats: { value: AudioFormat; label: string; description: string }[] = [
  { value: 'mp3', label: 'MP3', description: 'Compatível e leve' },
  { value: 'wav', label: 'WAV', description: 'Sem compressão' },
  { value: 'm4a', label: 'M4A', description: 'Ideal para Apple' },
  { value: 'ogg', label: 'OGG', description: 'Formato aberto' },
]

const bitrateOptions = [
  { value: 128, label: '128 kbps', hint: 'Arquivo menor' },
  { value: 192, label: '192 kbps', hint: 'Equilibrado' },
  { value: 256, label: '256 kbps', hint: 'Alta qualidade' },
  { value: 320, label: '320 kbps', hint: 'Qualidade máxima' },
]

const acceptedExtensions = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'mpeg', 'mpg']

function toolFromHash(): ActiveTool {
  if (window.location.hash === '#lead-intel' || window.location.hash === '#analise-empresas') return 'company-analysis'
  return 'converter'
}

function conversionModeFromHash(): ConversionMode {
  return window.location.hash === '#audio-texto' || window.location.hash === '#midia-texto' ? 'audio-text' : 'video-audio'
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return '—'
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}

function safeBaseName(name: string) {
  return name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9À-ÿ _-]/g, '').trim() || 'audio'
}

function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const ffmpegRef = useRef<FFmpeg | null>(null)
  const uploadRef = useRef<XMLHttpRequest | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [videoUrl, setVideoUrl] = useState('')
  const [duration, setDuration] = useState(0)
  const [format, setFormat] = useState<AudioFormat>('mp3')
  const [bitrate, setBitrate] = useState(192)
  const [status, setStatus] = useState<AppStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ConversionResult | null>(null)
  const [dragging, setDragging] = useState(false)
  const [activeTool, setActiveTool] = useState<ActiveTool>(toolFromHash)
  const [conversionMode, setConversionMode] = useState<ConversionMode>(conversionModeFromHash)

  const busy = status === 'uploading' || status === 'loading' || status === 'converting'
  const selectedBitrate = useMemo(
    () => bitrateOptions.find((option) => option.value === bitrate),
    [bitrate],
  )

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl)
    }
  }, [videoUrl])

  useEffect(() => {
    return () => {
      if (result?.url && !result.remote) URL.revokeObjectURL(result.url)
    }
  }, [result])

  useEffect(() => () => uploadRef.current?.abort(), [])

  useEffect(() => {
    const onHashChange = () => {
      setActiveTool(toolFromHash())
      setConversionMode(conversionModeFromHash())
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  function changeTool(tool: ActiveTool) {
    window.location.hash = tool === 'company-analysis' ? 'analise-empresas' : conversionMode === 'audio-text' ? 'midia-texto' : 'conversores'
    setActiveTool(tool)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function changeConversionMode(mode: ConversionMode) {
    setConversionMode(mode)
    setActiveTool('converter')
    window.location.hash = mode === 'audio-text' ? 'midia-texto' : 'conversores'
  }

  function resetResult() {
    if (result?.url && !result.remote) URL.revokeObjectURL(result.url)
    setResult(null)
    setProgress(0)
  }

  function selectFile(nextFile?: File) {
    if (!nextFile || busy) return
    const extension = nextFile.name.split('.').pop()?.toLowerCase() ?? ''
    if (!nextFile.type.startsWith('video/') && !acceptedExtensions.includes(extension)) {
      setError('Esse arquivo não parece ser um vídeo compatível. Tente MP4, MOV, AVI, MKV ou WebM.')
      setStatus('error')
      return
    }
    if (nextFile.size === 0) {
      setError('O arquivo está vazio. Escolha outro vídeo para continuar.')
      setStatus('error')
      return
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl)
    resetResult()
    setError('')
    setDuration(0)
    setFile(nextFile)
    setVideoUrl(URL.createObjectURL(nextFile))
    setStatus('ready')
  }

  function removeFile() {
    if (busy) return
    if (videoUrl) URL.revokeObjectURL(videoUrl)
    resetResult()
    setFile(null)
    setVideoUrl('')
    setDuration(0)
    setError('')
    setStatus('idle')
    if (inputRef.current) inputRef.current.value = ''
  }

  async function getFFmpeg() {
    if (!ffmpegRef.current) {
      const instance = new FFmpeg()
      instance.on('progress', ({ progress: nextProgress }) => {
        const normalized = Math.max(0, Math.min(1, nextProgress))
        setProgress(Math.round(normalized * 100))
      })
      ffmpegRef.current = instance
    }
    if (!ffmpegRef.current.loaded) {
      await ffmpegRef.current.load({ coreURL, wasmURL })
    }
    return ffmpegRef.current
  }

  function uploadToServer(video: File) {
    return new Promise<ServerJob>((resolve, reject) => {
      const request = new XMLHttpRequest()
      uploadRef.current = request
      const query = new URLSearchParams({ format, bitrate: String(bitrate) })
      request.open('POST', `/api/jobs?${query}`)
      request.responseType = 'json'
      request.setRequestHeader('Content-Type', video.type || 'application/octet-stream')
      request.setRequestHeader('X-Filename', encodeURIComponent(video.name))
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100))
      }
      request.onload = () => {
        uploadRef.current = null
        if (request.status >= 200 && request.status < 300) {
          resolve(request.response as ServerJob)
        } else {
          reject(new Error(request.response?.detail || 'A VPS recusou o envio do vídeo.'))
        }
      }
      request.onerror = () => {
        uploadRef.current = null
        reject(new Error('A conexão com a VPS foi interrompida durante o upload.'))
      }
      request.onabort = () => reject(new Error('O upload foi cancelado.'))
      request.send(video)
    })
  }

  async function waitForServerJob(jobId: string) {
    while (true) {
      const response = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('Não foi possível consultar o andamento da conversão.')
      const job = await response.json() as ServerJob
      setProgress(job.progress)
      if (job.status === 'ready') return job
      if (job.status === 'error') throw new Error(job.error || 'A conversão falhou na VPS.')
      await new Promise((resolve) => window.setTimeout(resolve, 1200))
    }
  }

  async function convertOnServer(video: File) {
    setStatus('uploading')
    setProgress(0)
    const queuedJob = await uploadToServer(video)
    setStatus('converting')
    setProgress(queuedJob.progress || 1)
    const completedJob = await waitForServerJob(queuedJob.id)
    if (!completedJob.download_url || !completedJob.output_name) {
      throw new Error('A VPS concluiu a tarefa, mas não retornou o arquivo de áudio.')
    }
    setResult({
      url: completedJob.download_url,
      name: completedJob.output_name,
      size: completedJob.output_size || 0,
      remote: true,
    })
    setProgress(100)
    setStatus('success')
  }

  async function convert() {
    if (!file || busy) return
    resetResult()
    setError('')
    setStatus('loading')
    setProgress(4)

    const inputExtension = file.name.split('.').pop()?.toLowerCase() || 'mp4'
    const inputName = `entrada-${Date.now()}.${inputExtension}`
    const outputName = `${safeBaseName(file.name)}.${format}`
    const virtualOutput = `saida-${Date.now()}.${format}`

    try {
      if (serverMode) {
        await convertOnServer(file)
        return
      }
      const ffmpeg = await getFFmpeg()
      setStatus('converting')
      setProgress(8)
      await ffmpeg.writeFile(inputName, await fetchFile(file))

      const codecArguments: Record<AudioFormat, string[]> = {
        mp3: ['-vn', '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`],
        wav: ['-vn', '-c:a', 'pcm_s16le'],
        m4a: ['-vn', '-c:a', 'aac', '-b:a', `${bitrate}k`, '-movflags', '+faststart'],
        ogg: ['-vn', '-c:a', 'libvorbis', '-b:a', `${bitrate}k`],
      }

      const exitCode = await ffmpeg.exec(['-i', inputName, ...codecArguments[format], virtualOutput])
      if (exitCode !== 0) throw new Error('A conversão não pôde ser concluída.')

      const data = await ffmpeg.readFile(virtualOutput)
      if (typeof data === 'string') throw new Error('O resultado gerado é inválido.')
      const mimeTypes: Record<AudioFormat, string> = {
        mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
      }
      const blob = new Blob([data.slice().buffer], { type: mimeTypes[format] })
      setResult({ url: URL.createObjectURL(blob), name: outputName, size: blob.size })
      setProgress(100)
      setStatus('success')
      await Promise.allSettled([ffmpeg.deleteFile(inputName), ffmpeg.deleteFile(virtualOutput)])
    } catch (conversionError) {
      console.error(conversionError)
      setError(serverMode && conversionError instanceof Error
        ? conversionError.message
        : serverMode
          ? 'Não foi possível concluir a conversão na VPS.'
          : 'Não foi possível converter este vídeo. Ele pode usar um codec incompatível ou ser grande demais para a memória do navegador.')
      setStatus('error')
      setProgress(0)
    }
  }

  return (
    <main className="app-shell">
      <nav className="topbar" aria-label="Navegação principal">
        <a className="brand" href="#conversores" aria-label="Media Tools — início">
          <strong>MEDIA</strong><span>TOOLS</span>
        </a>
        <div className="tool-switch" aria-label="Ferramentas do portal">
          <button type="button" className={activeTool === 'converter' ? 'active' : ''} onClick={() => changeTool('converter')}>Conversores</button>
          <button type="button" className={activeTool === 'company-analysis' ? 'active' : ''} onClick={() => changeTool('company-analysis')}>Análise de empresas</button>
        </div>
        <div className="privacy-note"><LockKeyhole size={15} /> {activeTool === 'company-analysis' ? 'Pesquisa pública auditada' : serverMode ? 'Processamento privado na VPS' : 'Processamento privado'}</div>
      </nav>

      {activeTool === 'converter' ? <>
      <section className="suite-intro" id="conversores">
        <div className="eyebrow"><span /> Central de conversão</div>
        <h1>Transforme sua mídia<br /><em>em poucos passos.</em></h1>
        <p>Escolha o que deseja fazer, envie o arquivo e acompanhe tudo em uma única tela.</p>
      </section>

      <section className={`converter-hub ${file && conversionMode === 'video-audio' ? 'has-file' : ''}`} aria-label="Central de conversão">
        <header className="hub-header">
          <div>
            <strong>O que você quer fazer?</strong>
            <span>Troque de ferramenta sem sair desta tela</span>
          </div>
          <div className="conversion-switch" role="tablist" aria-label="Tipo de conversão">
            <button type="button" role="tab" aria-selected={conversionMode === 'video-audio'} className={conversionMode === 'video-audio' ? 'active' : ''} onClick={() => changeConversionMode('video-audio')}><FileVideo2 size={17} /> Vídeo para áudio</button>
            <button type="button" role="tab" aria-selected={conversionMode === 'audio-text'} className={conversionMode === 'audio-text' ? 'active' : ''} onClick={() => changeConversionMode('audio-text')}><AudioWaveform size={17} /> Áudio ou vídeo → texto</button>
          </div>
        </header>

        {conversionMode === 'video-audio' ? <div className="converter-flow" role="tabpanel">
        <div className="converter-heading">
          <div><span className="heading-index">01</span><div><strong>Selecione o vídeo</strong><small>Depois você escolhe o formato e a qualidade</small></div></div>
          <span className="online-status"><i /> {serverMode ? 'VPS disponível' : 'Pronto para usar'}</span>
        </div>
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          accept="video/*,.mkv,.avi,.m4v"
          onChange={(event) => selectFile(event.target.files?.[0])}
          onInput={(event) => selectFile(event.currentTarget.files?.[0])}
          aria-label="Escolher arquivo de vídeo"
        />

        {!file ? (
          <button
            className={`dropzone ${dragging ? 'is-dragging' : ''}`}
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { event.preventDefault(); setDragging(false) }}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              selectFile(event.dataTransfer.files?.[0])
            }}
          >
            <span className="upload-icon"><UploadCloud size={30} strokeWidth={1.7} /></span>
            <strong>{dragging ? 'Pode soltar o vídeo' : 'Arraste seu vídeo para cá'}</strong>
            <span>ou <b>escolha um arquivo</b> no seu dispositivo</span>
            <small><i /> MP4, MOV, AVI, MKV, M4V e WebM</small>
          </button>
        ) : (
          <div className="workspace">
            <div className="preview-panel">
              <div className="video-frame">
                <video
                  src={videoUrl}
                  controls
                  preload="metadata"
                  onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
                />
                <span className="video-badge"><FileVideo2 size={13} /> Vídeo original</span>
              </div>
              <div className="file-summary">
                <span className="file-icon"><FileVideo2 size={20} /></span>
                <div className="file-copy">
                  <strong title={file.name}>{file.name}</strong>
                  <span>{formatBytes(file.size)} · {formatDuration(duration)} · {file.type || 'Vídeo'}</span>
                </div>
                <button className="icon-button" type="button" onClick={removeFile} disabled={busy} aria-label="Remover vídeo">
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="settings-panel">
              <div className="step-heading"><span>1</span><div><strong>Formato de saída</strong><small>Escolha como quer salvar o áudio</small></div></div>
              <div className="format-grid" role="radiogroup" aria-label="Formato de saída">
                {formats.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={format === option.value}
                    className={`format-option ${format === option.value ? 'selected' : ''}`}
                    onClick={() => { setFormat(option.value); resetResult(); if (status !== 'error') setStatus('ready') }}
                    disabled={busy}
                  >
                    <span>{option.label}</span><small>{option.description}</small>
                    {format === option.value && <i><Check size={11} /></i>}
                  </button>
                ))}
              </div>

              <div className="divider" />
              <div className="step-heading"><span>2</span><div><strong>Qualidade do áudio</strong><small>{format === 'wav' ? 'WAV mantém o áudio sem compressão' : 'Defina o equilíbrio entre tamanho e qualidade'}</small></div></div>
              {format === 'wav' ? (
                <div className="lossless-note"><AudioWaveform size={19} /><div><strong>PCM sem compressão</strong><span>Maior fidelidade e arquivo maior</span></div></div>
              ) : (
                <label className="quality-select">
                  <span>{selectedBitrate?.label}<small>{selectedBitrate?.hint}</small></span>
                  <select value={bitrate} onChange={(event) => { setBitrate(Number(event.target.value)); resetResult(); setStatus('ready') }} disabled={busy} aria-label="Qualidade do áudio">
                    {bitrateOptions.map((option) => <option key={option.value} value={option.value}>{option.label} — {option.hint}</option>)}
                  </select>
                </label>
              )}

              {(status === 'uploading' || status === 'loading' || status === 'converting') && (
                <div className="progress-card" aria-live="polite">
                  <div><span>{status === 'uploading' ? 'Enviando vídeo para a VPS…' : status === 'loading' ? 'Preparando o conversor…' : 'Extraindo o áudio…'}</span><strong>{progress}%</strong></div>
                  <div className="progress-track"><i style={{ width: `${Math.max(4, progress)}%` }} /></div>
                  <small>{status === 'uploading' ? 'Não feche a página até o upload terminar.' : 'Mantenha esta página aberta durante o processamento.'}</small>
                </div>
              )}

              {status === 'error' && error && (
                <div className="error-message" role="alert"><AlertCircle size={18} /><span>{error}</span></div>
              )}

              {status === 'success' && result ? (
                <div className="result-card" aria-live="polite">
                  <span className="success-icon"><Check size={22} /></span>
                  <div><small>Áudio pronto</small><strong>{result.name}</strong><span>{formatBytes(result.size)} · {format.toUpperCase()}</span></div>
                  <a className="download-button" href={result.url} download={result.name}><Download size={18} /> Baixar</a>
                </div>
              ) : (
                <button className="convert-button" type="button" onClick={convert} disabled={busy || status === 'error'}>
                  {busy ? <><RefreshCw className="spinning" size={19} /> {status === 'uploading' ? 'Enviando' : 'Processando'}</> : <><Sparkles size={19} /> Converter para {format.toUpperCase()}</>}
                </button>
              )}

              {status === 'success' && (
                <button className="new-file-button" type="button" onClick={removeFile}><RefreshCw size={15} /> Converter outro vídeo</button>
              )}
            </div>
          </div>
        )}

        {!file && (
          <div className="format-row" aria-label="Formatos disponíveis">
            <span>Converta para</span>
            <div>{formats.map((option) => <span className="format-pill" key={option.value}>{option.label}</span>)}</div>
          </div>
        )}
        </div> : <Transcriber />}
      </section>

      </> : <LeadIntel />}

      <footer><strong className="footer-brand">MEDIA <span>TOOLS</span></strong><span>Feito para simplificar o seu trabalho.</span><small>Rápido <i /> Privado <i /> Sem cadastro</small></footer>
    </main>
  )
}

export default App
