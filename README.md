# Action Elite

Jogo de tiro em primeira pessoa para o navegador, jogável **offline** e **online contra jogadores reais**.
Projeto novo, escrito do zero (TypeScript + three.js). Todo o conteúdo (mapa, armas, texturas, modelos, sons) é original e gerado por código:
não há arquivos de imagem, áudio ou modelo, nem dados ou protocolo de outro jogo. O resultado é **um único `action-elite.html`**.

## Plano em 5 partes

| Parte | Conteúdo | Estado |
|---|---|---|
| 1 | Base do jogo: motor, mapa, movimento, 6 armas, alvos, HUD, som, menus, configurações. Treino offline. | pronta |
| 2 | Bots com IA e modos offline: Deathmatch por equipes, Missão Bomba, rodadas, placar, minimapa, menus de sala, perfil e XP. | **pronta** |
| 3 | Servidor online (um arquivo só): salas, partidas multiplayer reais, Deathmatch e Missão Bomba online. | |
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

## Desenvolvimento

```sh
npm install
npm run dev          # http://localhost:8000
npm run test:sim     # regras do jogo e partidas só de bots (movimento, tiros, bomba, IA), sem navegador
npm run build        # gera dist/action-elite.html (um arquivo só)
```

## Estrutura

| Pasta | O que é |
|---|---|
| `src/sim/` | regras puras, sem three.js nem DOM, que rodarão também no servidor (parte 3): mapa, movimento, armas, tiros, `fighter.ts` (jogador ou bot), `match.ts` (modos, rodadas, bomba), `bot.ts` (IA) e `nav.ts` (caminhos). |
| `src/game/` | `game.ts`: o laço do jogo, que liga entrada, partida, 3D, HUD, som e menus. |
| `src/render/` | cena 3D, texturas geradas por código, modelos, arma em primeira pessoa, efeitos. |
| `src/ui/` | HUD, menus e estilos. |
| `src/core/` | entrada (teclado, mouse, trava do ponteiro), som sintetizado e configurações. |

## Licença

MIT, veja `LICENSE`.
