const CHAVE = String.raw`(?:[A-Za-z0-9_-]+|'[^'\r\n]*'|"(?:[^"\\\r\n]|\\(?:["\\btnfr]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}))*")`;
const CAMINHO = String.raw`${CHAVE}(?:[ \t]*\.[ \t]*${CHAVE})*`;
const TABELA = new RegExp(String.raw`^(\[\[?)[ \t]*(${CAMINHO})[ \t]*(\]\]?)[ \t]*(?:#.*)?$`);
const ATRIBUICAO = new RegExp(String.raw`^(${CAMINHO})[ \t]*=`);
const CAMPOS_EXECUCAO = new Set(['command', 'args']);

function formatoInseguro() {
  return new Error('não foi possível editar o TOML do Codex com segurança. Use uma tabela [mcp_servers.pjecalc] para o registro manual.');
}

// Localiza instruções completas sem interpretar valores ou confundir seu conteúdo com cabeçalhos.
function* instrucoes(texto) {
  const pilha = [];
  let inicio = texto.startsWith('\uFEFF') ? 1 : 0;
  let aspa = '';
  let multilinha = false;

  for (let i = inicio; i < texto.length; i++) {
    const c = texto[i];
    if (aspa) {
      if (c === '\\' && aspa === '"') {
        i++;
      } else if (c === aspa && !multilinha) {
        aspa = '';
      } else if (c === aspa && texto.startsWith(aspa.repeat(3), i)) {
        i += 2;
        while (texto[i + 1] === aspa) i++;
        aspa = '';
      } else if (c === '\n' && !multilinha) {
        throw formatoInseguro();
      }
    } else if (c === '#') {
      const quebra = texto.indexOf('\n', i);
      if (quebra < 0) break;
      i = quebra - 1;
    } else if (c === '"' || c === "'") {
      aspa = c;
      multilinha = texto.startsWith(c.repeat(3), i);
      if (multilinha) i += 2;
    } else if (c === '[' || c === '{') {
      pilha.push(c === '[' ? ']' : '}');
    } else if (c === ']' || c === '}') {
      if (pilha.pop() !== c) throw formatoInseguro();
    } else if (c === '\n' && !pilha.length) {
      yield { inicio, fim: i + 1 };
      inicio = i + 1;
    }
  }

  if (aspa || pilha.length) throw formatoInseguro();
  if (inicio < texto.length) yield { inicio, fim: texto.length };
}

function partes(caminho) {
  return caminho.match(new RegExp(CHAVE, 'g')).map((chave) => {
    if (chave.startsWith("'")) return chave.slice(1, -1);
    if (!chave.startsWith('"')) return chave;
    const emJson = chave.replace(/\\(?:U([0-9a-fA-F]{8})|.)/g, (trecho, hexadecimal) =>
      hexadecimal ? JSON.stringify(String.fromCodePoint(Number.parseInt(hexadecimal, 16))).slice(1, -1) : trecho);
    return JSON.parse(emJson);
  });
}

function pertenceAoPjeCalc(caminho) {
  return caminho[0] === 'mcp_servers' && caminho[1] === 'pjecalc';
}

function analisar(texto) {
  const remover = [];
  const camposExecucao = [];
  let escopo = [];
  let principal;
  let usaUrl = false;
  for (const trecho of instrucoes(texto)) {
    const instrucao = texto.slice(trecho.inicio, trecho.fim).trim();
    if (!instrucao || instrucao.startsWith('#')) continue;

    if (instrucao.startsWith('[')) {
      const tabela = TABELA.exec(instrucao);
      if (!tabela || tabela[1].length !== tabela[3].length) throw formatoInseguro();
      escopo = partes(tabela[2]);
      const vetor = tabela[1].length === 2;
      if (vetor && escopo.length === 1 && escopo[0] === 'mcp_servers') throw formatoInseguro();
      if (pertenceAoPjeCalc(escopo)) {
        if (escopo.length === 2) {
          if (vetor || principal) throw formatoInseguro();
          principal = trecho;
        } else if (CAMPOS_EXECUCAO.has(escopo[2])) {
          throw formatoInseguro();
        }
        if (escopo[2] === 'url') usaUrl = true;
        remover.push(trecho);
      }
      continue;
    }

    const atribuicao = ATRIBUICAO.exec(instrucao);
    if (!atribuicao) throw formatoInseguro();
    const caminho = [...escopo, ...partes(atribuicao[1])];
    if (caminho.length === 1 && caminho[0] === 'mcp_servers') throw formatoInseguro();
    if (!pertenceAoPjeCalc(caminho)) continue;
    if (!pertenceAoPjeCalc(escopo)) throw formatoInseguro();
    remover.push(trecho);
    if (caminho[2] === 'url') usaUrl = true;
    if (escopo.length === 2 && CAMPOS_EXECUCAO.has(caminho[2])) {
      if (caminho.length !== 3) throw formatoInseguro();
      camposExecucao.push(trecho);
    }
  }
  return { principal, remover, camposExecucao, usaUrl };
}

function editar(texto, edicoes) {
  let anterior = 0;
  let resultado = '';
  for (const { inicio, fim, novo = '' } of edicoes.sort((a, b) => a.inicio - b.inicio)) {
    resultado += texto.slice(anterior, inicio) + novo;
    anterior = fim;
  }
  return resultado + texto.slice(anterior);
}

function stringToml(valor) {
  return JSON.stringify(valor).replace(/\u007F/g, '\\u007F');
}

export function registrarCodex(texto, { command, args }) {
  const { principal, camposExecucao, usaUrl } = analisar(texto);
  if (usaUrl) throw new Error('o registro pjecalc usa transporte HTTP. Remova ou renomeie essa entrada antes de registrar o servidor local.');
  const quebra = texto.match(/\r?\n/)?.[0] ?? '\n';
  const execucao = `command = ${stringToml(command)}${quebra}args = [${args.map(stringToml).join(', ')}]${quebra}`;
  if (principal) {
    const posicao = principal.fim;
    const separador = texto[posicao - 1] === '\n' ? '' : quebra;
    return editar(texto, [{ inicio: posicao, fim: posicao, novo: separador + execucao }, ...camposExecucao]);
  }
  const separador = texto && texto !== '\uFEFF' ? (texto.endsWith('\n') ? quebra : quebra.repeat(2)) : '';
  return `${texto}${separador}[mcp_servers.pjecalc]${quebra}${execucao}`;
}

export function temRegistroCodex(texto) {
  return analisar(texto).remover.length > 0;
}

export function removerCodex(texto) {
  const { remover } = analisar(texto);
  return remover.length ? editar(texto, remover) : null;
}
