# Sonic - Conversor de vídeo para áudio

Aplicação React que extrai o áudio de vídeos locais diretamente no navegador com `ffmpeg.wasm`. O arquivo não é enviado a um servidor.

## Rodar no computador

Requisitos: Node.js 20 ou superior.

```bash
npm install
npm run dev
```

Abra o endereço exibido no terminal.

## Gerar a versão final

```bash
npm run build
npm run preview
```

## Formatos

- MP3, M4A e OGG com seleção de bitrate entre 128 e 320 kbps.
- WAV PCM sem compressão.

Arquivos muito grandes podem ultrapassar a memória disponível no navegador. O tempo de conversão varia conforme o tamanho do vídeo e a capacidade do dispositivo.

## Publicação

O workflow em `.github/workflows/deploy.yml` publica automaticamente a branch `main` no GitHub Pages.
