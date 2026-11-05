import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function preparar(t) {
  const raiz = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'pjecalc-instalador-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const repo = path.join(raiz, "PJe-Calc d'Água");
  const casa = path.join(raiz, 'perfil-ficticio');
  const appdata = path.join(casa, 'AppData', 'Roaming');
  const localappdata = path.join(casa, 'AppData', 'Local');
  const codex = path.join(casa, '.codex', 'config.toml');
  const vscode = path.join(appdata, 'Code', 'User', 'mcp.json');
  const servidor = path.join(repo, 'server', 'server.mjs');
  const preloader = path.join(raiz, 'perfil.cjs');

  function gravar(arquivo, conteudo) {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    fs.writeFileSync(arquivo, conteudo);
  }

  const pastaInstalador = path.join(repo, 'instalador');
  fs.mkdirSync(pastaInstalador, { recursive: true });
  for (const arquivo of ['instalador.mjs', 'codex-config.mjs']) {
    fs.copyFileSync(new URL(`../instalador/${arquivo}`, import.meta.url), path.join(pastaInstalador, arquivo));
  }
  gravar(preloader, `
require('node:os').homedir = () => process.env.PJECALC_TEST_HOME;
require('node:module').syncBuiltinESMExports();
`);
  gravar(path.join(repo, 'server', 'lib', 'localizar.mjs'), `
export const localizar = async () => ({ valida: true, pasta: 'PJe-Calc fictício' });
export const arquivoConfig = () => new URL('./config-ausente.json', import.meta.url);
`);
  gravar(path.join(repo, 'scripts', 'cliente-mcp.mjs'), `
export const conectar = async () => ({
  init: { result: { serverInfo: { version: 'fictício' } } },
  enviar: async () => ({ result: { tools: [] } }),
  ferramenta: async () => ({ valido: true }),
  fechar() {},
});
`);
  gravar(path.join(repo, 'exemplos', 'calculo-referencia.json'), '{}');

  function rodar(modo) {
    return execFileSync(process.execPath, ['--require', preloader, path.join('instalador', 'instalador.mjs'), modo, '--sim'], {
      cwd: repo,
      env: { ...process.env, PJECALC_TEST_HOME: casa, APPDATA: appdata, LOCALAPPDATA: localappdata, INSTALADOR_SEM_CLI: '1' },
      encoding: 'utf8',
      timeout: 10_000,
    });
  }

  return { codex, vscode, servidor, gravar, rodar };
}

test('registrar no Codex preserva tabelas indentadas de outros servidores e CRLF', (t) => {
  const { codex, gravar, rodar } = preparar(t);
  const outraTabela = '  [mcp_servers.outro] # manter\r\n  command = "outro.exe"\r\n';
  gravar(codex, `[mcp_servers.pjecalc]\r\ncommand = 'antigo.exe'\r\n\r\n${outraTabela}`);

  rodar('instalar');

  const resultado = fs.readFileSync(codex, 'utf8');
  assert.ok(resultado.includes(outraTabela), 'a tabela alheia deve permanecer intacta');
  assert.doesNotMatch(resultado, /(?<!\r)\n/);
});

test('registrar no Codex ignora cabeçalhos aparentes em instruções multilinha', (t) => {
  const { codex, gravar, rodar } = preparar(t);
  const instrucoes = 'developer_instructions = """\n[mcp_servers.pjecalc]\ntexto a preservar\n"""\n';
  gravar(codex, `${instrucoes}\n[mcp_servers.pjecalc]\ncommand = 'antigo.exe'\n`);

  rodar('instalar');

  const resultado = fs.readFileSync(codex, 'utf8');
  assert.ok(resultado.startsWith(instrucoes), 'as instruções devem permanecer intactas');
  assert.doesNotMatch(resultado, /antigo\.exe/);
});

test('desinstalar do Codex remove subtabelas de pjecalc e mantém registros de nome semelhante', (t) => {
  const { codex, gravar, rodar } = preparar(t);
  const outraTabela = '[mcp_servers.pjecalc_extra]\ncommand = "outro.exe"\n';
  gravar(codex, `[mcp_servers.pjecalc]\ncommand = 'antigo.exe'\n\n${outraTabela}\n  [mcp_servers."pjecalc".env]\nPJECALC_HOME = 'D:\\PJeCalc'\n`);

  rodar('desinstalar');

  const resultado = fs.readFileSync(codex, 'utf8');
  assert.ok(resultado.includes(outraTabela));
  assert.doesNotMatch(resultado, /PJECALC_HOME|antigo\.exe/);
});

test('registrar novamente no Codex mantém as opções do servidor', (t) => {
  const { codex, gravar, rodar } = preparar(t);
  const opcoes = "enabled = false\nstartup_timeout_sec = 45\nenv = { PJECALC_HOME = 'D:\\PJeCalc' }\n";
  gravar(codex, `[mcp_servers.pjecalc]\ncommand = 'antigo.exe'\nargs = ['antigo.mjs']\n${opcoes}`);

  rodar('instalar');

  const resultado = fs.readFileSync(codex, 'utf8');
  assert.ok(resultado.includes(opcoes));
  assert.doesNotMatch(resultado, /antigo\./);
});

test('registrar no Codex não sobrescreve uma configuração com servidores inline', (t) => {
  const { codex, gravar, rodar } = preparar(t);
  const original = 'mcp_servers = { outro = { command = "outro.exe" } }\n';
  gravar(codex, original);

  const saida = rodar('instalar');

  assert.equal(fs.readFileSync(codex, 'utf8'), original);
  assert.match(saida, /Codex: não consegui registrar/);
  assert.deepEqual(fs.readdirSync(path.dirname(codex)), ['config.toml']);
});

test('registrar no Codex conserva a entrada remota e orienta a resolver o conflito de nome', (t) => {
  const { codex, gravar, rodar } = preparar(t);
  const original = '[mcp_servers.pjecalc]\nurl = "https://exemplo.invalid/mcp"\n';
  gravar(codex, original);

  const saida = rodar('instalar');

  assert.equal(fs.readFileSync(codex, 'utf8'), original);
  assert.match(saida, /Codex: não consegui registrar.+usa transporte HTTP/);
  assert.deepEqual(fs.readdirSync(path.dirname(codex)), ['config.toml']);
});

test('registrar no Codex representa caminhos com barras e apóstrofos em TOML', (t) => {
  const { codex, servidor, gravar, rodar } = preparar(t);
  gravar(codex, '');

  rodar('instalar');

  const resultado = fs.readFileSync(codex, 'utf8');
  const args = /^args = (.+)\r?$/m.exec(resultado)[1];
  assert.doesNotThrow(() => JSON.parse(args), 'o argumento deve ser uma string básica TOML com barras escapadas');
  assert.deepEqual(JSON.parse(args), [servidor]);
});

test('registrar no VS Code atualiza a execução e preserva as opções da entrada existente', (t) => {
  const { vscode, servidor, gravar, rodar } = preparar(t);
  const env = { PJECALC_HOME: 'D:\\PJeCalc', PJECALC_MCP_SAIDA: 'D:\\Cálculos' };
  const outro = { type: 'stdio', command: 'outro.exe' };
  gravar(vscode, JSON.stringify({ servers: { pjecalc: { type: 'stdio', command: 'antigo.exe', args: ['antigo.mjs'], disabled: true, env }, outro } }));

  rodar('instalar');

  const resultado = JSON.parse(fs.readFileSync(vscode, 'utf8'));
  assert.deepEqual(resultado.servers, {
    pjecalc: { type: 'stdio', command: process.execPath, args: [servidor], disabled: true, env },
    outro,
  });
});

test('registrar no VS Code substitui o transporte remoto e mantém as opções comuns', (t) => {
  const { vscode, servidor, gravar, rodar } = preparar(t);
  const pjecalc = { type: 'http', url: 'https://exemplo.invalid/mcp', headers: { 'X-Ficticio': 'sim' }, disabled: true };
  gravar(vscode, JSON.stringify({ servers: { pjecalc } }));

  rodar('instalar');

  const resultado = JSON.parse(fs.readFileSync(vscode, 'utf8'));
  assert.deepEqual(resultado.servers.pjecalc, { type: 'stdio', command: process.execPath, args: [servidor], disabled: true });
});
