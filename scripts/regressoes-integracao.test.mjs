import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { OperadorPjeCalc } from '../server/lib/operacoes.mjs';
import { Pagina } from '../server/lib/web.mjs';

const baseFicticia = 'http://pjecalc.invalid';
const campoIrpf = 'formulario:cobrarEncargosIrpf';

async function importarEmVm(relativo, modulos, contexto = createContext()) {
  const arquivo = new URL(relativo, import.meta.url);
  const modulo = new SourceTextModule(fs.readFileSync(arquivo, 'utf8'), {
    context: contexto,
    initializeImportMeta(meta) { meta.url = arquivo.href; },
  });
  await modulo.link((nome) => {
    const valores = modulos[nome];
    assert.ok(valores, `dependência sem stub: ${nome}`);
    return new SyntheticModule(Object.keys(valores), function () {
      for (const [chave, valor] of Object.entries(valores)) this.setExport(chave, valor);
    }, { context: contexto });
  });
  await modulo.evaluate();
  return modulo.namespace;
}

for (const { cobrarEncargosIrpf, precatorio } of [
  { cobrarEncargosIrpf: false },
  { cobrarEncargosIrpf: true },
  { cobrarEncargosIrpf: false, precatorio: { tipo: 'RPV', esfera: 'FEDERAL', inicioGraca: '2016-07-01', fimGraca: '2016-08-31' } },
]) {
  test(`atualização envia cobrança de IRPF conforme a opção ${cobrarEncargosIrpf}${precatorio ? ' nos POSTs do fluxo de precatório' : ''}`, async (t) => {
    const url = `${baseFicticia}/pjecalc/atualizar.jsf`;
    const html = `<form id="formulario" action="${url}">
      <input id="formulario:dataDeLiquidacaoInputDate" name="formulario:dataDeLiquidacaoInputDate">
      <input type="checkbox" id="${campoIrpf}" name="${campoIrpf}" checked="checked">
      <input type="checkbox" id="formulario:atualizarRegraPrecatorio" name="formulario:atualizarRegraPrecatorio"
        onchange="A4J.AJAX.Submit('formulario',event,{})">
      <select name="formulario:tipoPrecatorio"><option value="RPV">RPV</option></select>
      <select name="formulario:tipoEsferaPrecatorio" onchange="A4J.AJAX.Submit('formulario',event,{})">
        <option value="FEDERAL">Federal</option>
      </select>
      <input type="submit" id="formulario:liquidar" name="formulario:liquidar" value="Liquidar">
    </form>`;
    const postagens = [];
    t.mock.method(globalThis, 'fetch', async (destino, opcoes) => {
      assert.equal(destino, url);
      if (opcoes.method === 'POST') postagens.push(new URLSearchParams(opcoes.body));
      return new Response(html, { headers: { 'Content-Type': 'text/html;charset=ISO-8859-1' } });
    });
    const op = new OperadorPjeCalc(baseFicticia);
    op.s.menu = async () => (op.s.pagina = new Pagina(url, html));
    await op.liquidarAtualizacao({ data: '2016-08-31', cobrarEncargosIrpf, precatorio });
    assert.equal(postagens.length, precatorio ? 3 : 1);
    for (const dados of postagens) assert.equal(dados.get(campoIrpf), cobrarEncargosIrpf ? 'on' : null);
  });
}

const pastaA = 'C:\\Instalação A\\PJe-Calc';
const pastaB = 'D:\\Instalação B\\PJe-Calc';
const java = (pasta, nome) => path.win32.join(pasta, 'bin', 'jre', 'bin', nome);
const processoNormal = (ProcessId, pasta) => ({
  ProcessId,
  ExecutablePath: java(pasta, 'javaw.exe'),
  CommandLine: `"${java(pasta, 'javaw.exe')}" -Duser.timezone=GMT-3 -jar bin\\pjecalc.jar`,
});
const processoSemNavegador = (ProcessId, pasta) => ({
  ProcessId,
  ExecutablePath: java(pasta, 'java.exe'),
  CommandLine: `"${java(pasta, 'java.exe')}" -cp "bin\\pjecalc.jar;C:\\MCP Local\\iniciar.jar" -Xms1024m br.jus.pjecalcmcp.IniciarSemNavegador`,
});

async function cicloDeVida(processos, { aoEscrever = null, aoIniciar = null } = {}) {
  const operacoes = { encerrados: [], arquivos: [], inicializacoes: [] };
  let executando = [...processos];
  let selecionada = pastaA;
  let pronta = false;
  let agora = Date.now();
  const estado = {
    remover: (pid) => { executando = executando.filter((p) => p.ProcessId !== pid); },
    adicionar: (p) => { executando.push(p); },
    selecionar: (pasta) => { selecionada = pasta; },
    responder: () => { pronta = true; },
  };
  const contexto = createContext({
    AbortSignal,
    Date: class extends Date {
      constructor() { super(agora); }
      static now() { return agora; }
    },
    async fetch() {
      return { status: pronta ? 200 : 503, text: async () => pronta ? 'PJe-Calc' : '' };
    },
    setTimeout(callback, ms) { agora += ms; queueMicrotask(callback); },
  });
  const modulos = {
    'node:child_process': {
      execFile(_arquivo, args, _opcoes, callback) {
        const comando = args.at(-1);
        const ids = /Stop-Process -Id ([\d,]+)/.exec(comando);
        if (ids) {
          for (const pid of ids[1].split(',').map(Number)) {
            operacoes.encerrados.push(pid);
            estado.remover(pid);
          }
          callback(null, '', '');
          return;
        }
        assert.match(comando, /Get-CimInstance Win32_Process/);
        const stdout = comando.includes('ConvertTo-Json') ? JSON.stringify(executando)
          : executando.map((p) => `${p.ProcessId}|${p.CommandLine}`).join('\n');
        callback(null, stdout, '');
      },
      spawn(executavel, args, opcoes) {
        operacoes.inicializacoes.push({ executavel, args, opcoes });
        assert.ok(aoIniciar, 'não deveria iniciar o PJe-Calc neste caso');
        return { pid: aoIniciar(estado), unref() {} };
      },
    },
    'node:fs': { default: {
      existsSync: () => false,
      mkdirSync() {},
      unlinkSync() {},
      writeFileSync(arquivo) { operacoes.arquivos.push(arquivo); aoEscrever?.(estado); },
    } },
    'node:path': { default: path.win32 },
    'node:net': { default: { connect() {
      const socket = new EventEmitter();
      socket.destroy = () => {};
      queueMicrotask(() => socket.emit(pronta ? 'connect' : 'error'));
      return socket;
    } } },
    'node:url': { fileURLToPath },
    './env.mjs': {
      home: () => selecionada,
      javaExe: () => java(selecionada, 'java.exe'),
      readPorts: () => ({ http: 9257 }),
      readLauncherParams: () => ({}),
      logsDir: () => path.win32.join(selecionada, 'tomcat', 'logs'),
      dadosDir: () => path.win32.join(selecionada, '.dados'),
    },
    './localizar.mjs': { ehInstalacao: () => ({ pasta: selecionada }), localizar: async () => ({ valida: true }) },
    './rest.mjs': { baseUrl: () => baseFicticia },
  };
  const ciclo = await importarEmVm('../server/lib/lifecycle.mjs', modulos, contexto);
  return { ciclo, operacoes, estado };
}

test('parada forçada encerra somente a JVM oficial da instalação selecionada', async () => {
  const normal = processoNormal(111, pastaA);
  const { ciclo, operacoes } = await cicloDeVida([
    { ...normal, ExecutablePath: normal.ExecutablePath.toLowerCase().replace(/\\/g, '/') },
    processoNormal(222, pastaB),
    { ...normal, ProcessId: 333, ExecutablePath: null },
    { ...normal, ProcessId: 444, CommandLine: `"${normal.ExecutablePath}" -jar "${path.win32.join(pastaB, 'bin', 'pjecalc.jar')}"` },
  ]);
  await ciclo.stop({ forcar: true });
  assert.deepEqual(operacoes.encerrados, [111]);
});

test('parada ordenada do modo sem navegador conserva o alvo durante troca de seleção', async () => {
  const { ciclo, operacoes } = await cicloDeVida([processoSemNavegador(111, pastaA), processoSemNavegador(222, pastaB)], {
    aoEscrever(estado) { estado.remover(111); estado.selecionar(pastaB); },
  });
  const st = await ciclo.stop({ aguardarMs: 2000 });
  assert.deepEqual(operacoes.arquivos, [path.win32.join(pastaA, '.dados', 'pjecalc-mcp.parar')]);
  assert.deepEqual(operacoes.encerrados, []);
  assert.equal(st.encerrado, true);
});

test('status lista somente os processos da instalação selecionada com os campos públicos originais', async () => {
  const { ciclo } = await cicloDeVida([processoSemNavegador(111, pastaA), processoNormal(222, pastaB)]);
  const st = await ciclo.status();
  assert.deepEqual(JSON.parse(JSON.stringify(st.processos)), [{ pid: 111, modo: 'sem-navegador' }]);
});

test('início normal não espera um processo que pertence a outra instalação', async () => {
  const { ciclo, operacoes } = await cicloDeVida([processoNormal(222, pastaB)], {
    aoIniciar(estado) { estado.adicionar(processoNormal(111, pastaA)); estado.responder(); return 111; },
  });
  const st = await ciclo.start({ modo: 'normal', aguardarMs: 1000 });
  assert.equal(operacoes.inicializacoes[0]?.executavel, java(pastaA, 'javaw.exe'));
  assert.equal(st.pronto, true);
});

test('config_ler usa a instalação descoberta no início e a nova instalação após pjecalc_localizar', async () => {
  const requireServidor = createRequire(new URL('../server/server.mjs', import.meta.url));
  const ferramentas = new Map();
  let selecionada = 'C:\\Fallback';
  let concluirDescoberta;
  const descoberta = new Promise((resolve) => { concluirDescoberta = resolve; });
  const arquivo = (...partes) => path.win32.join(selecionada, ...partes);
  const arquivos = {
    [path.win32.join(pastaA, 'tomcat', 'conf', 'server.xml')]: 'Configuração A',
    [path.win32.join(pastaB, 'tomcat', 'conf', 'server.xml')]: 'Configuração B',
  };
  const modulos = {
    '@modelcontextprotocol/server': { McpServer: class {
      registerTool(nome, { inputSchema }, executar) { ferramentas.set(nome, (args) => executar(inputSchema.parse(args))); }
      registerResource() {}
      registerPrompt() {}
      async connect() {}
    } },
    '@modelcontextprotocol/server/stdio': { StdioServerTransport: class {} },
    zod: requireServidor('zod'),
    'node:path': { default: path.win32 },
    'node:fs': { default: { readFileSync(caminho, codificacao) {
      assert.equal(codificacao, 'latin1');
      if (!(caminho in arquivos)) throw new Error(`Arquivo inexistente: ${caminho}`);
      return arquivos[caminho];
    } } },
    'node:url': { fileURLToPath },
    './lib/env.mjs': {
      serverXmlPath: () => arquivo('tomcat', 'conf', 'server.xml'),
      contextXmlPath: () => arquivo('tomcat', 'webapps', 'pjecalc', 'META-INF', 'context.xml'),
      tomcatDir: () => arquivo('tomcat'),
      webappDir: () => arquivo('tomcat', 'webapps', 'pjecalc'),
      batNormal: () => arquivo('iniciarPjeCalc.bat'),
      batDebug: () => arquivo('iniciarPjeCalcDebug.bat'),
    },
    './lib/localizar.mjs': {
      async localizar() { await descoberta; selecionada = pastaA; return { valida: true, pasta: pastaA }; },
      escolher(pasta) { selecionada = pasta; return { valida: true, pasta }; },
    },
    './lib/anotacoes.mjs': { anotacoesDe: () => ({}) },
    './lib/operacoes.mjs': { OperadorPjeCalc },
    './lib/gerador.mjs': { numeroCnj() {}, cpfValido() {}, cnpjValido() {}, COLUNAS_APURACAO: [] },
    './lib/h2.mjs': {}, './lib/rest.mjs': {}, './lib/lifecycle.mjs': {}, './lib/servico-calculo.mjs': {},
    './lib/documentos.mjs': {}, './lib/plano.mjs': {}, './lib/conversores.mjs': {},
  };
  const contexto = createContext({ process: { on() {}, exit(code) { assert.fail(`saída do servidor simulado: ${code}`); } }, console: { error() {} } });
  await importarEmVm('../server/server.mjs', modulos, contexto);
  concluirDescoberta();
  const ler = ferramentas.get('config_ler');
  const antes = await ler({ arquivo: 'server.xml' });
  await ferramentas.get('pjecalc_localizar')({ pasta: pastaB });
  const depois = await ler({ arquivo: 'server.xml' });
  const conteudos = [antes, depois].map((r) => r.isError ? r.content[0].text : JSON.parse(r.content[0].text).conteudo);
  assert.deepEqual(conteudos, ['Configuração A', 'Configuração B']);
});
