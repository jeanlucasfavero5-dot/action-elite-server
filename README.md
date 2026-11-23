# Action Elite

Jogo de tiro em primeira pessoa para o navegador, jogável **offline** e **online contra jogadores reais**.
Projeto novo, escrito do zero (TypeScript + three.js). Todo o conteúdo (mapa, armas, texturas, modelos, sons) é original e gerado por código:
não há arquivos de imagem, áudio ou modelo, nem dados ou protocolo de outro jogo. O resultado é **um único `action-elite.html`**.

## Plano em 5 partes

| Parte | Conteúdo | Estado |
|---|---|---|
| 1 | Base do jogo: motor, mapa, movimento, 6 armas, alvos, HUD, som, menus, configurações. Treino offline. | pronta |
| 2 | Bots com IA e modos offline: Deathmatch por equipes, Missão Bomba, rodadas, placar, minimapa, menus de sala, perfil e XP. | pronta |
| 3 | Servidor online (um arquivo só): salas, partidas multiplayer reais, Deathmatch e Missão Bomba online. | **pronta** |
| 4 | Loja, inventário, diamantes (Supabase), progressão e mais modos: Sabotagem, Defesa, HeadHunter, Caos. | |
| 5 | Acabamento: mais mapas, armas e efeitos, toque e controle, offline completo, balanceamento e implantação (Render + Supabase). | |

## Como jogar

Abra `action-elite.html` no navegador (duplo clique serve). **Modos offline** cria uma partida contra bots; **Treino offline** é o campo de tiro.

- **Deathmatch por equipes:** 1 a 8 jogadores por lado, limite de abates e de tempo, renascimento em 3 s com proteção de 2 s.
- **Missão Bomba:** rodadas sem renascimento. Os atacantes plantam a bomba (segure **E** por 3 s dentro do local A ou B), os defensores desarmam (**E** por 5 s ao lado dela). A bomba explode em 30 s. Troca de lados no meio da partida.
- **Bots:** quatro dificuldades (Fácil, Normal, Difícil, Elite). Veem, ouvem tiros, desviam, plantam e desarmam.
- **Perfil:** apelido, nível, XP e estatísticas, guardados no navegador.

| Tecla | Ação |
|---|---|
| W A S D | mover |
| Mouse | mirar |
| Botão esquerdo | atirar |
| Botão direito | mira da Longbow (2 níveis de zoom) |
| Shift / Espaço / Ctrl ou C | correr / pular / agachar |
| R | recarregar |
| 1 a 6 ou roda do mouse | trocar de arma (Machete, Viper P9, Spitfire S35, Raptor AR, Hammer 12, Longbow X) |
| Q | arma anterior |
| E (segurar) | plantar / desarmar a bomba |
| Tab (segurar) | placar |
| Esc | pausar |

## Jogar online

**Jogar online** conecta ao servidor, mostra as salas, permite criar uma (modo, jogadores por equipe, bots nas vagas vazias, dificuldade, limites), entrar numa, trocar de equipe, escolher a arma, conversar e iniciar. **Partida rápida** entra numa sala aberta ou cria uma com bots. Quem sai no meio da partida é substituído por um bot.

- **Servidor:** `npm run server` roda local na porta 8090. `npm run pack:server` gera `dist-server/action-elite-server.mjs`, o servidor inteiro em **um arquivo** (Node 20 ou mais novo, só `node action-elite-server.mjs`). No Render: Build Command `echo ok`, Start Command `node action-elite-server.mjs`, `NODE_VERSION=22`. Variáveis: `PORT` (o Render define) e `AE_ORIGINS` (os sites autorizados, por exemplo `https://meusite.com`).
- **Jogo:** em `action-elite.html`, edite a linha `<meta name="ae-server" content="https://SEU-SERVICO.onrender.com" />`. Sem ela, o jogo procura o servidor no mesmo endereço, porta 8090.
- **Como funciona:** o servidor roda as mesmas regras do jogo offline (`src/sim`) a 60 ciclos por segundo e envia o estado 20 vezes por segundo. O navegador prevê o movimento do próprio jogador (sem atraso), corrige se o servidor discordar e desenha os outros jogadores com 100 ms de atraso, suavizados. Os tiros são conferidos pelo servidor, com compensação de lag (até 300 ms).
- **Limites:** 16 jogadores por sala, 40 salas, 300 conexões. Mensagens malformadas e excesso de mensagens são descartados.

## Desenvolvimento

```sh
npm install
npm run dev          # http://localhost:8000
npm run test:sim     # regras do jogo e partidas só de bots (movimento, tiros, bomba, IA), sem navegador
npm run test:net     # servidor e cliente online de verdade: salas, movimento, tiros, compensação de lag, bots no lugar de quem sai
npm run build        # gera dist/action-elite.html (um arquivo só)
```

## Estrutura

| Pasta | O que é |
|---|---|
| `src/sim/` | regras puras, sem three.js nem DOM, que rodarão também no servidor (parte 3): mapa, movimento, armas, tiros, `fighter.ts` (jogador ou bot), `match.ts` (modos, rodadas, bomba), `bot.ts` (IA) e `nav.ts` (caminhos). |
| `src/game/` | `game.ts`: o laço do jogo, que liga entrada, partida, 3D, HUD, som e menus. |
| `src/render/` | cena 3D, texturas geradas por código, modelos, arma em primeira pessoa, efeitos. |
| `src/ui/` | HUD, menus e estilos. |
| `src/net/` | protocolo, conexão e a partida online no navegador (predição, correção, interpolação). |
| `server/` | o servidor online: `server.ts` (salas e partidas) e `index.ts` (a entrada). |
| `src/core/` | entrada (teclado, mouse, trava do ponteiro), som sintetizado e configurações. |

## Licença

MIT, veja `LICENSE`.
