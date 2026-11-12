# Action Elite Server

Servidor do jogo Action Elite (versão 0.0.5): Auth, Game e a porta web (WebSocket + `/api`) em **um processo só**.
Roda no **Render** e guarda os dados no **Supabase** (Postgres). O jogo em si é uma página separada, `action-elite.html`, que fica no seu site.

> **Aviso legal.** Este repositório tem só código. `server/runtime/Config` e `server/runtime/Data` e `db/init/001_init.sql` trazem dados de jogo que pertencem à Zepetto e não são cobertos pela licença MIT (ver `LICENSE`). Use com um cliente que você tem direito de usar.

## O que você precisa

| Item | Onde pegar |
|---|---|
| URL do banco (Session pooler, porta 5432) | Supabase → **Connect** → Session pooler. Troque `[YOUR-PASSWORD]` pela senha do banco. |
| Chave de servidor | Supabase → **Project Settings → API keys** → secret (`service_role`). Só vai no Render, nunca na página do jogo. |
| Endereço do seu site | Onde `action-elite.html` fica, por exemplo `https://meusite.com` |

## 1. Criar as tabelas no Supabase (uma vez)

Com Docker (funciona em qualquer sistema), na pasta deste repositório:

```sh
docker run --rm -i postgres:16 psql "SUA_URL_DO_BANCO" < db/init/001_init.sql
```

Ou, se você tem o `psql`: `psql "SUA_URL_DO_BANCO" -f db/init/001_init.sql`. Mensagens `\restrict` em versões antigas do psql podem ser ignoradas.

O servidor tranca essas tabelas na API REST do Supabase (RLS ligado, sem acesso para `anon`) a cada início, então a chave pública do seu Hub não enxerga logins nem senhas do jogo. As tabelas do Hub (`usuarios`, `carteira_diamantes`) não são tocadas.

## 2. Subir no Render

1. Coloque esta pasta num repositório do GitHub.
2. No Render: **New → Blueprint**, escolha o repositório (usa o `render.yaml`).
3. Preencha as três variáveis pedidas: `PB_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `PB_WEB_ORIGINS`.
4. Quando o deploy terminar, abra `https://SEU-SERVICO.onrender.com/health`: deve responder `{"ok":true,...}`.

Para criar sem o Blueprint: Web Service, Node, Build `npm install --omit=dev`, Start `node server/index.ts`, Health Check `/health`, com as mesmas variáveis mais `NODE_VERSION=22`, `PB_NO_TCP=1` e `PB_DB_SSL=1`.

## 3. Apontar a página do jogo para o servidor

Em `action-elite.html`, edite esta linha (uma só, sem recompilar):

```html
<meta name="ae-server" content="https://SEU-SERVICO.onrender.com" />
```

## Variáveis de ambiente

Todas estão comentadas em `server/.env.example`. As principais:

| Variável | Para que serve |
|---|---|
| `PB_DB_URL` | Conexão com o Postgres do Supabase (Session pooler). |
| `PB_DB_SSL` | `1` liga TLS (obrigatório no Supabase). |
| `SUPABASE_URL` | Projeto do Hub (padrão já configurado). |
| `SUPABASE_SERVICE_ROLE_KEY` | Cobra diamantes em `carteira_diamantes`. Sem ela a loja recusa diamantes. |
| `PB_WEB_ORIGINS` | Sites autorizados a abrir o jogo (CORS e WebSocket), separados por vírgula. |
| `PB_NO_TCP` | `1` no Render: sem portas TCP, só a porta web. |
| `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` | Servidor TURN, para jogadores atrás de NAT restrito. |

## Observações

- O plano gratuito do Render dorme após 15 minutos sem tráfego, o que derruba todos os jogadores. Use um plano pago.
- Use o Session pooler (porta 5432), não o Transaction pooler (6543).
- Rodar local: `npm install`, crie `.env.local` dentro de `server/` (veja `server/.env.example`) e `npm start`.
