# Media Tools — Mídia e inteligência comercial

Ferramenta que extrai o áudio de vídeos locais diretamente no navegador com `ffmpeg.wasm`. O arquivo não é enviado a um servidor.

O mesmo portal também inclui **Mídia para Texto**, que transcreve áudio ou vídeo com Whisper local na VPS, e **Análise de Empresas**, uma pesquisa empresarial com salvaguardas de privacidade e fontes rastreáveis.

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

## Versão para vídeos grandes em VPS

O projeto inclui uma implantação Docker separada para processar vídeos grandes com FFmpeg nativo na VPS. Ela oferece:

- upload em fluxo direto para disco, sem copiar o vídeo inteiro para a memória;
- fila com limite configurável de conversões simultâneas;
- progresso de upload e processamento;
- persistência do estado da tarefa;
- limite de tamanho e reserva mínima de disco;
- remoção automática de arquivos;
- frontend e API na mesma origem, servidos pelo Caddy;
- proteção inicial por usuário e senha.
- transcrição local de áudio e vídeo com `whisper.cpp`, sem enviar gravações a APIs externas.

Veja o roteiro completo em [`DEPLOY_VPS.md`](./DEPLOY_VPS.md).

## Áudio ou vídeo para texto

Abra **Conversores → Áudio ou vídeo → texto** ou use `#midia-texto` no endereço. O endereço legado `#audio-texto` continua compatível.

- aceita áudio em MP3, WAV, M4A, AAC, OGG, FLAC, OPUS, WMA e WebM;
- aceita vídeo em MP4, MOV, AVI, MKV, M4V, MPEG, MPG e WebM, extraindo o áudio automaticamente;
- detecta o idioma automaticamente ou prioriza português, inglês e espanhol;
- permite revisar, editar, copiar e baixar a transcrição em TXT;
- processa uma tarefa pesada por vez para proteger a VPS;
- usa decodificação sem timestamps e busca reduzida para diminuir o tempo de processamento na VPS;
- remove o áudio e o texto conforme `RETENTION_HOURS`;
- limita a duração por `MAX_TRANSCRIPTION_HOURS`, com padrão de 6 horas.

A transcrição automática pode errar nomes próprios, números e termos técnicos. Revise o texto antes de usar em documentação, CRM ou decisões.

## Análise de Empresas

Abra **Análise de empresas** na navegação superior ou use `#analise-empresas` no final do endereço. O endereço legado `#lead-intel` continua compatível.

O MVP permite:

- colar o dado disponível no card do Kommo e deixar a ferramenta identificar automaticamente se é CNPJ, domínio/e-mail corporativo ou nome/contexto;
- consultar cadastro empresarial por CNPJ via BrasilAPI/Minha Receita;
- exibir natureza jurídica, capital social, matriz/filial, telefones comerciais, e-mail cadastral e quadro societário quando a fonte retornar esses campos;
- ler título, descrição e canais empresariais publicados no domínio informado;
- pesquisar o nome, empresa, cidade ou contexto do lead na web quando `BRAVE_SEARCH_API_KEY` estiver configurada;
- visualizar a fonte e a data de cada consulta;
- declarar finalidade e justificativa antes da pesquisa;
- manter auditoria minimizada: o log grava hashes, finalidade, provedores e contagens, nunca a consulta ou justificativa em texto aberto;
- bloquear CPF, telefone, e-mail pessoal, dados sensíveis e endereços internos.

O recurso é apoio à pesquisa B2B e não garante conformidade jurídica por si só. A empresa deve definir base legal, aviso de privacidade, retenção, canal do titular, perfis de acesso e revisão periódica com seu responsável por privacidade.

### Pesquisa web opcional

Crie uma chave no painel oficial do Brave Search e configure apenas no backend:

```dotenv
BRAVE_SEARCH_API_KEY=valor_no_cofre_de_segredos
RESEARCH_RATE_LIMIT=30
```

Sem essa chave, CNPJ e domínio continuam disponíveis. A pesquisa ampla por nome mostra que o provedor ainda não foi configurado.
