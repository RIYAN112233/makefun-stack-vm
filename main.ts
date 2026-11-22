// Tiny stack VM for make.fun tiny-stack-vm-01-run-20261122 (kit ISA.md).
// 32-bit wrapping values, 256-value stack, 64-deep call stack, 256 memory
// words, byte I/O, traps 2-11. One run answers every instance in the input dir.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Pure two-operand ops, indexed by opcode - 0x10; holes are DIV/MOD/DIVU/
// MODU (own traps) and NEG/NOT (unary).
const BIN = [(a,b)=>(a+b)|0,(a,b)=>(a-b)|0,Math.imul,,,,,,(a,b)=>a&b,(a,b)=>a|b,(a,b)=>a^b,,(a,b)=>a<<(b&31),(a,b)=>a>>(b&31),(a,b)=>(a>>>(b&31))|0,,(a,b)=>a===b?1:0,(a,b)=>a<b?1:0,(a,b)=>(a>>>0)<(b>>>0)?1:0];

function run(p, inp) {
  const s = new Int32Array(256);
  const c = new Int32Array(64);
  const m = new Int32Array(256);
  const out = new Uint8Array(65536);
  let sp = 0, cp = 0, pc = 0, ip = 0, ol = 0, k = 0;
  const done = (code) => ({ out: out.slice(0, ol), code });
  for (;;) {
    // Trap order is the ISA's: step limit, pc range, truncated immediate.
    // A trap here costs no step. Unknown opcodes fall to the switch default.    if (k === 1e6) return done(10);
    if (pc < 0 || pc >= p.length) return done(9);
    const op = p[pc];
    const imm = op === 0x01 ? 1 : op === 0x02 ? 4 : op >= 0x30 && op <= 0x33 ? 2 : 0;
    if (pc + imm >= p.length) return done(9);
    k++;
    const nx = pc + 1 + imm;
    pc = nx;
    switch (op) {
      case 0x00:
        return done(0);
      case 0x01:
        if (sp === 256) return done(3);
        s[sp++] = (p[nx - 1] << 24) >> 24;
        break;
      case 0x02:
        if (sp === 256) return done(3);
        s[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24);
        break;
      case 0x03:
        if (sp < 1) return done(2);
        sp--;
        break;
      case 0x04:
        if (sp < 1) return done(2);
        if (sp === 256) return done(3);
        s[sp] = s[sp - 1];
        sp++;
        break;
      case 0x05:
        if (sp < 2) return done(2);
        { const t = s[sp - 1]; s[sp - 1] = s[sp - 2]; s[sp - 2] = t; }
        break;
      case 0x06:
        if (sp < 2) return done(2);
        if (sp === 256) return done(3);
        s[sp] = s[sp - 2];
        sp++;
        break;
      case 0x07: // ROT: (a b c -- b c a)
        if (sp < 3) return done(2);
        { const a = s[sp - 3]; s[sp - 3] = s[sp - 2]; s[sp - 2] = s[sp - 1]; s[sp - 1] = a; }
        break;
      case 0x17:
      case 0x1b:
        if (sp < 1) return done(2);
        s[sp - 1] = op === 0x17 ? (-s[sp - 1]) | 0 : ~s[sp - 1];
        break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22:
        if (sp < 2) return done(2);
        { const b = s[sp - 1], a = s[sp - 2];
          let r;
          if (op === 0x13) { // DIV: signed, truncates toward zero; INT_MIN / -1 stays INT_MIN
            if (b === 0) return done(4);
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
          } else if (op === 0x14) { // MOD: sign of the dividend; x % -1 is 0
            if (b === 0) return done(4);
            r = b === -1 ? 0 : (a % b) | 0;
          } else if (op === 0x15) {
            if (b === 0) return done(4);
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
          } else if (op === 0x16) {
            if (b === 0) return done(4);
            r = ((a >>> 0) % (b >>> 0)) | 0;
          } else r = BIN[op - 0x10](a, b);
          sp -= 2;
          s[sp++] = r; }
        break;
      case 0x30:
      case 0x31:
      case 0x32: // signed 16-bit offset from next instruction
        { const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
          let take = true;
          if (op !== 0x30) {
            if (sp < 1) return done(2);
            const v = s[--sp];
            take = op === 0x31 ? v === 0 : v !== 0;
          }
          if (take) pc = nx + rel; }
        break;
      case 0x33: // CALL: pushes next instruction, unsigned 16-bit target
        if (cp === 64) return done(7);
        c[cp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return done(8);
        pc = c[--cp];
        break;
      case 0x40:
        if (sp < 1) return done(2);
        { const addr = s[sp - 1];
          if (addr < 0 || addr > 255) return done(6);
          s[sp - 1] = m[addr]; }
        break;
      case 0x41: // STORE: top of stack is the address
        if (sp < 2) return done(2);
        { const addr = s[sp - 1];
          if (addr < 0 || addr > 255) return done(6);
          m[addr] = s[sp - 2];
          sp -= 2; }
        break;
      case 0x50: // PRINT: past the cap traps 11, writes nothing
        if (sp < 1) return done(2);
        { const t = String(s[sp - 1]);
          if (ol + t.length > 65536) return done(11);
          sp--;
          for (let i = 0; i < t.length; i++) out[ol++] = t.charCodeAt(i); }
        break;
      case 0x51:
        if (sp < 1) return done(2);
        if (ol + 1 > 65536) return done(11);
        out[ol++] = s[--sp] & 255;
        break;
      case 0x52: // IN: -1 once exhausted
        if (sp === 256) return done(3);
        s[sp++] = ip < inp.length ? inp[ip++] : -1;
        break;
      case 0x53:
        if (sp < 1) return done(2);
        return done(s[--sp] & 255);
      default:
        return done(5);
    }
  }
}

for (const id of readdirSync(I).sort()) {
  const r = run(new Uint8Array(readFileSync(join(I, id, 'program.bin'))), new Uint8Array(readFileSync(join(I, id, 'input.bin'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), `${r.code}\n`);
}
