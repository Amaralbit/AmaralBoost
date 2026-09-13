# Amaral Boost

Um protótipo desktop local para organizar revisões de desempenho do Windows sem prometer ganhos ou alterar o sistema automaticamente.

## Executar

```powershell
npm install
npm start
```

## Gerar instalador (.exe)

```powershell
npm install
npm run dist
```

Gera `dist/Amaral Boost Setup <versão>.exe` (instalador NSIS assistido, com atalho de área de trabalho e menu Iniciar). A pasta `dist/` não é versionada. O ícone ainda é o padrão do Electron — personalizar o ícone continua pendente.

## O que já funciona

- Painel escuro em português, com indicadores de sistema explicitamente marcados como aguardando leitura.
- Leitura local de CPU, GPU, RAM e versão do Windows.
- Tela Desempenho: monitor em tempo real (CPU, memória, GPU, disco e rede) com mini-gráfico de histórico por métrica, atualizado a cada ~2,5s só enquanto a tela está aberta (pausa sozinho quando o app vai pra bandeja). CPU e memória vêm do Node; GPU, disco e rede vêm de classes WMI `Win32_PerfFormattedData_*` — deliberadamente não usa `Get-Counter`, cujos nomes de contador são traduzidos em Windows não-inglês e falham em silêncio num Windows em português.
- Perfis Equilibrado, Gamer e Economia de Bateria, com confirmação explícita: alteram o plano de energia ativo e o Game Mode do usuário atual (Equilibrado só isso; Gamer e Economia de Bateria também aplicam um pacote curado de ajustes individuais).
- Snapshot local persistente antes da primeira alteração; Padrão Windows restaura exatamente esse estado e não faz nada se não houver snapshot.
- Histórico local persistente (sobrevive a reinícios), com data/hora e perfil de cada ação, resultado individual de plano de energia e Game Mode, botão para limpar (com confirmação) e botão para exportar um diagnóstico em JSON (leitura do sistema + estado dos perfis + histórico).
- Bandeja do Windows com abertura rápida e opção de encerrar completamente.
- Ajustes individuais (tela Perfis, catálogo em `src/tweaks.js`): 16 ajustes, quase todos mudando uma ou poucas chaves de registro (do usuário atual, ou de administrador quando marcado), aplicados e revertidos por um motor genérico que lê o valor original antes de mudar e guarda esse valor para desfazer com exatidão depois. Dois deles (os de Modo de Energia) são "nativos": declaram `native` em vez de `regOps` porque a preferência que eles mudam não é gravável por registro — ver abaixo. O perfil Padrão Windows reverte automaticamente qualquer um destes que ainda esteja aplicado, mesmo sem snapshot de perfil. Quando uma versão nova acrescenta chaves a um ajuste que a pessoa já tinha aplicado, aplicar de novo grava só as chaves que faltam e as soma ao backup — as antigas não são relidas, senão o backup guardaria o valor já alterado e a reversão perderia o original. Ajustes cuja mudança de registro só valeria no próximo login (ex.: aceleração do mouse) declaram `refresh` e o motor avisa o Windows na hora, ao aplicar e ao reverter.
- Limpeza (mesma tela): 3 ações de uma vez só sem estado para reverter — temporários, cache de DNS e memória em standby — com confirmação antes de rodar.
- Perfil Gamer expandido: além de energia e Game Mode, aplica um pacote curado de 12 ajustes individuais + 1 limpeza — entre eles aceleração do mouse desligada, notificações desligadas, Game DVR bloqueado também por política de máquina e prioridade de disco alta no perfil "Jogos" do MMCSS — (definido em `GAMER_BUNDLE`, em `src/tweaks.js`), inspirado no que apps como o Dilera Boost vendem como modo competitivo — sem nada trancado atrás de pagamento, e com cada item listado na tela de revisão antes de confirmar. Um item bloqueado (ex.: exige administrador) não impede os demais.
- Perfil Economia de Bateria: ativa o plano Economia de energia do Windows, desliga o Game Mode (ele reserva GPU/CPU para o app em primeiro plano, sem relação com consumo) e aplica um pacote de 5 ajustes individuais que reduzem trabalho em segundo plano — apps da Store, pré-carregamento do Edge, efeitos visuais, notificações e o Modo de Energia na bateria (definido em `BATTERY_BUNDLE`, em `src/tweaks.js`). Mesma revisão item a item e mesma reversão pelo Padrão Windows.
- Plano de energia e "Modo de Energia" são coisas diferentes, e o app trata cada uma pelo caminho que realmente funciona. O **plano** (Equilibrado / Alto desempenho / Economia de energia) é trocado por `powercfg /setactive` e conferido por `/getactivescheme`: o `powercfg /list` NÃO é usado como pré-requisito, porque o Windows 11 esconde dele os planos clássicos de desempenho — eles continuam existindo e ativáveis, e usar o /list como porteiro fazia o perfil Gamer falhar com "Alto desempenho não está disponível" em máquinas onde o plano existe. O **Modo de Energia** (Configurações > Energia e bateria) é o seletor separado, por fonte de energia: a chave de registro que guarda essa preferência só aceita escrita de SYSTEM — Administradores têm apenas leitura, então nem o app elevado consegue gravar ali. O caminho usado é `PowerSetActiveOverlayScheme` (powrprof.dll, não exige elevação), que só atua sobre a fonte ativa no momento; por isso o ajuste guarda a fonte alvo e o app reaplica sozinho ao trocar de tomada para bateria (evento `powerMonitor`) e ao abrir. O valor anterior é lido antes (leitura é permitida) e é ele que o Padrão Windows restaura.
- Tela Gerenciamento de RAM (`src/ram-limit.js`): mostra o uso combinado dos navegadores reconhecidos e o top de processos do sistema por memória (leitura local, mesmo espírito da tela Desempenho). Também oferece, como recurso avançado e opcional, um teto de RAM combinado para todos os navegadores reconhecidos ao mesmo tempo — via um Job Object do Windows com `JobMemoryLimit`, aplicado por uma Tarefa Agendada que roda um script auxiliar em segundo plano (sobrevive a fechar o Amaral Boost completamente, mas não a reiniciar o Windows). **É a única função do app que não é revertível na hora**: por semântica do Windows, um processo colocado num limite de memória não pode ser "solto" sem fechá-lo — desativar só impede que processos novos entrem no limite. A tela deixa isso explícito antes de ativar.

As alterações continuam propositalmente restritas: o app não encerra processos, não desinstala nada, não muda serviços, exclusões de antivírus ou segurança. Qualquer ajuste adicional deve incluir efeito conhecido, confirmação explícita e uma rota de reversão — e entra no catálogo um de cada vez.
