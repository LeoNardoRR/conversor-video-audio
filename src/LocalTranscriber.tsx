import { useRef, useState } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import coreURL from '../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js?url'
import wasmURL from '../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm?url'
import { AlertCircle, AudioLines, Check, Clipboard, Download, FileAudio2, FileVideo2, LoaderCircle, UploadCloud, X } from 'lucide-react'

type Segment = { start: number; end: number; text: string }
type DownloadFormat = 'txt' | 'doc' | 'md' | 'srt' | 'vtt'
type Stage = 'idle' | 'preparing' | 'model' | 'transcribing' | 'done'

const accepted = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'wma', 'webm', 'mp4', 'mov', 'avi', 'mkv', 'm4v', 'mpeg', 'mpg']
const modelId = 'Xenova/whisper-tiny'

function timestamp(seconds: number, separator: ',' | '.' = ',') {
  const milliseconds = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000)
  const secs = Math.floor(milliseconds % 60_000 / 1000)
  const millis = milliseconds % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`
}

function asMono(buffer: AudioBuffer) {
  const mono = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel)
    for (let index = 0; index < mono.length; index += 1) mono[index] += samples[index] / buffer.numberOfChannels
  }
  return mono
}

async function prepareAudio(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() || 'media'
  let audioBuffer: AudioBuffer
  const context = new AudioContext()
  try {
    try {
      audioBuffer = await context.decodeAudioData(await file.arrayBuffer())
    } catch {
      const ffmpeg = new FFmpeg()
      await ffmpeg.load({ coreURL, wasmURL })
      const input = `input.${extension}`
      await ffmpeg.writeFile(input, await fetchFile(file))
      const exitCode = await ffmpeg.exec(['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', 'speech.wav'])
      if (exitCode !== 0) throw new Error('Não foi possível extrair o áudio deste arquivo.')
      const data = await ffmpeg.readFile('speech.wav')
      if (typeof data === 'string') throw new Error('O áudio extraído é inválido.')
      audioBuffer = await context.decodeAudioData(data.slice().buffer)
      ffmpeg.terminate()
    }

    if (audioBuffer.duration > 3600) throw new Error('Nesta versão no navegador, escolha um arquivo de até 60 minutos.')
    if (audioBuffer.sampleRate === 16000) return asMono(audioBuffer)
    const targetLength = Math.ceil(audioBuffer.duration * 16000)
    const offline = new OfflineAudioContext(1, targetLength, 16000)
    const source = offline.createBufferSource()
    source.buffer = audioBuffer
    source.connect(offline.destination)
    source.start()
    return asMono(await offline.startRendering())
  } finally {
    await context.close()
  }
}

export default function LocalTranscriber() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [language, setLanguage] = useState('auto')
  const [stage, setStage] = useState<Stage>('idle')
  const [modelProgress, setModelProgress] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [segments, setSegments] = useState<Segment[]>([])
  const [downloadFormat, setDownloadFormat] = useState<DownloadFormat>('txt')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [dragging, setDragging] = useState(false)

  const busy = stage === 'preparing' || stage === 'model' || stage === 'transcribing'
  const isVideo = !!file && (file.type.startsWith('video/') || ['mp4', 'mov', 'avi', 'mkv', 'm4v', 'mpeg', 'mpg'].includes(file.name.split('.').pop()?.toLowerCase() || ''))

  function selectFile(next?: File) {
    if (!next || busy) return
    const extension = next.name.split('.').pop()?.toLowerCase() || ''
    if (!accepted.includes(extension) && !next.type.startsWith('audio/') && !next.type.startsWith('video/')) {
      setError('Escolha um arquivo de áudio ou vídeo compatível.')
      return
    }
    if (!next.size || next.size > 250 * 1024 * 1024) {
      setError('Escolha um arquivo com conteúdo e tamanho de até 250 MB.')
      return
    }
    setFile(next)
    setText('')
    setSegments([])
    setError('')
    setModelProgress(null)
    setStage('idle')
  }

  async function transcribe() {
    if (!file || busy) return
    setError('')
    setStage('preparing')
    try {
      const audio = await prepareAudio(file)
      setStage('model')
      const { pipeline } = await import('@huggingface/transformers')
      const recognizer = await pipeline('automatic-speech-recognition', modelId, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: (event: { status?: string; progress?: number }) => {
          if (event.status === 'progress' && typeof event.progress === 'number') setModelProgress(Math.round(event.progress))
        },
      })
      setStage('transcribing')
      const result = await recognizer(audio, {
        language: language === 'auto' ? undefined : language,
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
      }) as unknown as { text: string; chunks?: { timestamp: [number, number]; text: string }[] }
      setText(result.text.trim())
      setSegments((result.chunks || []).map((chunk) => ({
        start: chunk.timestamp[0],
        end: Number.isFinite(chunk.timestamp[1]) ? chunk.timestamp[1] : audio.length / 16000,
        text: chunk.text.trim(),
      })))
      setStage('done')
    } catch (cause) {
      console.error(cause)
      setError(cause instanceof Error ? cause.message : 'Não foi possível transcrever este arquivo.')
      setStage('idle')
    }
  }

  function download() {
    if (!text.trim()) return
    const name = (file?.name.replace(/\.[^.]+$/, '') || 'transcricao').replace(/[\\/:*?"<>|]/g, '-').slice(0, 100)
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    let content = `${text.trim()}\n`
    let mime = 'text/plain;charset=utf-8'
    if (downloadFormat === 'md') content = `# Transcrição\n\n${text.trim()}\n`
    if (downloadFormat === 'doc') {
      content = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(name)}</title></head><body style="font-family:Arial;line-height:1.6">${escape(text.trim()).replace(/\n/g, '<br>')}</body></html>`
      mime = 'application/msword;charset=utf-8'
    }
    if (downloadFormat === 'srt') content = segments.map((part, index) => `${index + 1}\n${timestamp(part.start)} --> ${timestamp(part.end)}\n${part.text}\n`).join('\n')
    if (downloadFormat === 'vtt') content = `WEBVTT\n\n${segments.map((part) => `${timestamp(part.start, '.')} --> ${timestamp(part.end, '.')}\n${part.text}\n`).join('\n')}`
    const url = URL.createObjectURL(new Blob([content], { type: mime }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${name}-transcricao.${downloadFormat}`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function copy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  return <div className="local-transcriber" role="tabpanel">
    <div className="converter-heading"><div><span className="heading-index">01</span><div><strong>Selecione um áudio ou vídeo</strong><small>A fala será reconhecida no seu dispositivo</small></div></div><span className="online-status"><i /> Sem envio do arquivo</span></div>
    <input ref={inputRef} className="sr-only" type="file" accept="audio/*,video/*,.mkv,.avi,.m4v,.wma" aria-label="Escolher áudio ou vídeo" onChange={(event) => selectFile(event.target.files?.[0])} />
    {!file ? <button className={`dropzone ${dragging ? 'is-dragging' : ''}`} type="button" onClick={() => inputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={(event) => { event.preventDefault(); setDragging(false) }} onDrop={(event) => { event.preventDefault(); setDragging(false); selectFile(event.dataTransfer.files?.[0]) }}><span className="upload-icon"><UploadCloud size={30} /></span><strong>{dragging ? 'Pode soltar o arquivo' : 'Arraste seu áudio ou vídeo para cá'}</strong><span>ou <b>escolha um arquivo</b> no seu dispositivo</span><small>MP3, WAV, M4A, MP4, MOV, MKV e mais · até 250 MB</small></button> : <div className="local-file"><span>{isVideo ? <FileVideo2 size={21} /> : <FileAudio2 size={21} />}</span><div><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(1)} MB · {isVideo ? 'Vídeo' : 'Áudio'}</small></div><button type="button" aria-label="Remover arquivo" disabled={busy} onClick={() => { setFile(null); setText(''); setSegments([]); setStage('idle'); if (inputRef.current) inputRef.current.value = '' }}><X size={18} /></button></div>}
    <div className="local-controls"><label><strong>Idioma da fala</strong><select value={language} onChange={(event) => setLanguage(event.target.value)} disabled={busy}><option value="auto">Detectar automaticamente</option><option value="portuguese">Português</option><option value="english">Inglês</option><option value="spanish">Espanhol</option></select></label><p>O modelo de reconhecimento será baixado na primeira utilização. Arquivos grandes podem demorar e exigem memória do dispositivo.</p></div>
    {error && <div className="error-message" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}
    {busy && <div className="local-progress" role="status"><LoaderCircle className="spinning" size={19} /><span>{stage === 'preparing' ? 'Preparando o áudio…' : stage === 'model' ? `Baixando o modelo…${modelProgress === null ? '' : ` ${modelProgress}%`}` : 'Reconhecendo as falas…'}</span></div>}
    {file && stage !== 'done' && <button className="convert-button" type="button" disabled={busy} onClick={transcribe}><AudioLines size={19} />{busy ? 'Processando…' : isVideo ? 'Transcrever vídeo' : 'Transcrever áudio'}</button>}
    {stage === 'done' && <div className="local-result"><div className="local-result-heading"><div><Check size={18} /><strong>Texto pronto para revisar</strong></div><button type="button" onClick={copy}><Clipboard size={15} /> {copied ? 'Copiado' : 'Copiar texto'}</button></div><textarea aria-label="Texto transcrito" value={text} onChange={(event) => setText(event.target.value)} spellCheck /><div className="local-download"><label>Formato <select value={downloadFormat} onChange={(event) => setDownloadFormat(event.target.value as DownloadFormat)}><option value="txt">Texto (.txt)</option><option value="doc">Word (.doc)</option><option value="md">Markdown (.md)</option><option value="srt" disabled={!segments.length}>Legendas (.srt)</option><option value="vtt" disabled={!segments.length}>Legendas web (.vtt)</option></select></label><button type="button" onClick={download}><Download size={16} /> Baixar</button></div><small>Revise nomes próprios, números e termos técnicos antes de usar. As legendas refletem a transcrição original; alterações feitas no texto não atualizam os tempos.</small></div>}
    {!file && <div className="format-row"><span>Transcrição no navegador</span><div><span className="format-pill">TXT</span><span className="format-pill">DOC</span><span className="format-pill">SRT</span><span className="format-pill">VTT</span></div></div>}
  </div>
}
