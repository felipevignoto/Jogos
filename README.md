# Jogos

Jogos de velocidade e reflexo para o navegador, jogados com o teclado e com música.
Sem dependências: HTML, CSS e JavaScript puro, com a música gerada pelo próprio navegador (Web Audio).

## Pulso — jogo de ritmo

Notas caem em 6 pistas (`A S D` · `J K L`). Aperte a tecla quando a nota cruzar a linha.

- **Modo clássico:** música gerada pelo jogo, que acelera a cada 8 compassos.
- **Música do computador:** escolha um arquivo de áudio; o jogo analisa a música inteira
  (andamento, batidas e ataques) e cria as notas em cima dela. Fácil, Normal ou Difícil.
- **Link do YouTube:** cole um link e jogue com o vídeo sincronizado. Precisa rodar no seu PC (abaixo).
- **Calibração** (tecla `C`) para compensar o atraso do fone/caixa de som, e medidor de cedo/tarde.
- Errou demais? A energia acaba e você recomeça do zero.

### Rodando o Pulso com links do YouTube

```bash
pip install yt-dlp
python pulso/server.py
```

No Windows, basta dar dois cliques em `pulso/jogar.bat`. O jogo abre em `http://localhost:8765`.
O servidor baixa o áudio do vídeo com o [yt-dlp](https://github.com/yt-dlp/yt-dlp) para a pasta
`pulso/cache/` (fora do git). Use só para jogar você mesmo: baixar conteúdo do YouTube vai contra os
termos de uso deles.

## Digita — jogo de digitação

Digite a palavra antes que a barra de tempo acabe. As palavras começam curtas e fáceis e ficam mais
longas e difíceis a cada 20 segundos. Os pontos dependem da velocidade (PPM), do tamanho da palavra
e do combo. Acentos são opcionais (`mae` vale para `mãe`). Cada letra certa toca uma nota da música.

## Controles

| Tecla | Pulso | Digita |
|---|---|---|
| Começar | `Espaço` | `Enter` |
| Pausar | `Esc` | `Esc` |
| Encerrar (na pausa) | `Q` | `Q` |
| Extra | `C` calibra, `V` vídeo, `[` `]` atraso | `Tab` música |
