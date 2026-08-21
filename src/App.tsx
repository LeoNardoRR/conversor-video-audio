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
  WandSparkles,
  X,
} from 'lucide-react'
import './App.css'

type AudioFormat = 'mp3' | 'wav' | 'm4a' | 'ogg'
type AppStatus = 'idle' | 'ready' | 'loading' | 'converting' | 'success' | 'error'

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
  const [file, setFile] = useState<File | null>(null)
  const [videoUrl, setVideoUrl] = useState('')
  const [duration, setDuration] = useState(0)
  const [format, setFormat] = useState<AudioFormat>('mp3')
  const [bitrate, setBitrate] = useState(192)
  const [status, setStatus] = useState<AppStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ url: string; name: string; size: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const busy = status === 'loading' || status === 'converting'
  const selectedBitrate = useMemo(
    () => bitrateOptions.find((option) => option.value === bitrate),
    [bitrate],
  )

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl)
      if (result?.url) URL.revokeObjectURL(result.url)
    }
  }, [videoUrl, result])

  function resetResult() {
    if (result?.url) URL.revokeObjectURL(result.url)
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
      setError('Não foi possível converter este vídeo. Ele pode usar um codec incompatível ou ser grande demais para a memória do navegador.')
      setStatus('error')
      setProgress(0)
    }
  }

  return (
    <main className="app-shell">
      <nav className="topbar" aria-label="Navegação principal">
        <a className="brand" href="#top" aria-label="Sonic — início">
          <span className="brand-mark"><AudioWaveform size={18} strokeWidth={2.25} /></span>
          <span>Sonic</span>
        </a>
        <div className="privacy-note"><LockKeyhole size={14} /> Seus arquivos não saem do dispositivo</div>
      </nav>

      <section className={`hero ${file ? 'hero-compact' : ''}`} id="top">
        <div className="eyebrow"><WandSparkles size={14} /> Conversão privada no navegador</div>
        <h1>Do vídeo para o áudio.<br /><em>Simples assim.</em></h1>
        <p>Extraia o som dos seus vídeos em poucos cliques, com qualidade e privacidade.</p>
      </section>

      <section className={`converter ${file ? 'has-file' : ''}`} aria-label="Conversor de vídeo para áudio">
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
            <span className="upload-icon"><UploadCloud size={28} strokeWidth={1.8} /></span>
            <strong>{dragging ? 'Pode soltar o vídeo' : 'Solte seu vídeo aqui'}</strong>
            <span>ou clique para escolher um arquivo</span>
            <small>MP4, MOV, AVI, MKV, M4V e WebM</small>
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

              {(status === 'loading' || status === 'converting') && (
                <div className="progress-card" aria-live="polite">
                  <div><span>{status === 'loading' ? 'Preparando o conversor…' : 'Extraindo o áudio…'}</span><strong>{progress}%</strong></div>
                  <div className="progress-track"><i style={{ width: `${Math.max(4, progress)}%` }} /></div>
                  <small>Mantenha esta página aberta durante o processamento.</small>
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
                  {busy ? <><RefreshCw className="spinning" size={19} /> Processando</> : <><Sparkles size={19} /> Converter para {format.toUpperCase()}</>}
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
      </section>

      <footer><span>Rápido</span><i /> <span>Privado</span><i /> <span>Sem cadastro</span></footer>
    </main>
  )
}

export default App
