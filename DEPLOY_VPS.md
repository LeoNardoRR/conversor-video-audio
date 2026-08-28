# Publicar o conversor na Oracle VPS

Esta implantação hospeda o frontend e uma API de conversão na mesma VPS. O vídeo é recebido em fluxo direto para o disco, processado com FFmpeg nativo e removido automaticamente.

## 1. Conferir a VPS

Abra o Terminal dentro da VPS e execute:

```bash
cat /etc/os-release
uname -m
df -h /
docker --version
docker compose version
```

A imagem Docker funciona em ARM64 (`aarch64`), que é a arquitetura da Oracle Ampere A1. Se Docker ou Docker Compose não estiverem instalados, siga a instalação oficial correspondente ao sistema exibido em `/etc/os-release`.

## 2. Liberar as portas na Oracle Cloud

Na VCN usada pela instância, adicione regras de entrada TCP:

- porta `80` para HTTP e emissão inicial do certificado;
- porta `443` para HTTPS;
- mantenha a porta usada pelo acesso remoto atual.

Restrinja SSH e RDP ao seu próprio IP sempre que possível. Não exponha a porta `8000`: ela é usada apenas entre os containers.

## 3. Baixar o projeto

```bash
git clone https://github.com/LeoNardoRR/conversor-video-audio.git
cd conversor-video-audio
cp .env.example .env
```

Se o projeto já estiver na VPS:

```bash
cd conversor-video-audio
git pull --ff-only
```

## 4. Criar a senha de acesso

Para impedir que terceiros ocupem o disco e o processador da VPS, a versão de arquivos grandes começa protegida por usuário e senha.

Gere o hash sem colocar a senha no histórico do terminal:

```bash
docker run --rm -it caddy:2.10-alpine caddy hash-password
```

Digite uma senha forte quando solicitado e copie o hash retornado. Depois abra o arquivo:

```bash
nano .env
```

Configure inicialmente:

```dotenv
SITE_ADDRESS=:80
BASIC_AUTH_USER=komanda
BASIC_AUTH_HASH='COLE_O_HASH_AQUI'
MAX_UPLOAD_GB=12
MIN_FREE_GB=5
RETENTION_HOURS=6
MAX_CONCURRENT_JOBS=1
```

Mantenha aspas simples ao redor do hash.

## 5. Iniciar

```bash
sudo docker compose up -d --build
sudo docker compose ps
```

Confira os registros:

```bash
sudo docker compose logs --tail=100 backend web
```

Abra no navegador o IP público da VPS. O navegador solicitará o usuário e a senha configurados.

O acesso por IP nesta etapa usa HTTP e serve somente para validação inicial. Não envie vídeos sensíveis até configurar o domínio e o HTTPS.

## 6. Ativar HTTPS com domínio

Crie um registro DNS do tipo `A`, apontando um subdomínio para o IP público da VPS. Exemplo:

```text
conversor.seudominio.com.br
```

Depois altere `.env`:

```dotenv
SITE_ADDRESS=conversor.seudominio.com.br
```

Recarregue:

```bash
sudo docker compose up -d
sudo docker compose logs --tail=100 web
```

Com as portas `80` e `443` acessíveis, o Caddy obtém e renova o certificado HTTPS automaticamente.

## 7. Operação

Verificar saúde e espaço livre:

```bash
sudo docker compose exec backend python -c "import json,urllib.request; print(json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/health')))"
df -h /
sudo docker system df
```

Atualizar o projeto:

```bash
git pull --ff-only
sudo docker compose up -d --build
```

Parar sem apagar os arquivos temporários:

```bash
sudo docker compose stop
```

Os vídeos de entrada são apagados assim que a conversão termina. Áudios prontos e tarefas com erro são removidos após o tempo definido em `RETENTION_HOURS`.
