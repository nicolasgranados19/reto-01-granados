import { describe, expect, test } from "bun:test"
import { analizar } from "../src/agent/loop"

describe("needsConfirmation por campos por confirmar", () => {
  test("lista requiere_confirmacion no vacía marca pide", () => {
    const t = JSON.stringify({ ok: true, data: { llenos: [], requiere_confirmacion: [{ etiqueta: "RUC", nota: "identificador extranjero" }] } })
    expect(analizar(t).pide).toBe(true)
  })
  test("campo con estado requiere_confirmacion anidado marca pide", () => {
    const t = JSON.stringify({ ok: true, data: { campos: [{ etiqueta: "RUC", estado: "requiere_confirmacion" }] } })
    expect(analizar(t).pide).toBe(true)
  })
  test("campos_por_confirmar no vacío marca pide", () => {
    expect(analizar(JSON.stringify({ ok: true, data: { campos_por_confirmar: ["RUC"] } })).pide).toBe(true)
  })
  test("sin pendientes no marca pide", () => {
    const t = JSON.stringify({ ok: true, data: { llenos: [{ etiqueta: "X", estado: "lleno" }], requiere_confirmacion: [], confirmaciones: [] } })
    expect(analizar(t).pide).toBe(false)
  })
  test("el resultado real de mapear_campos de ec-corp-andina marca pide", async () => {
    const { cpSync, mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "reto01-loop-"))
    cpSync(join(import.meta.dir, "..", "fixtures"), join(dir, "fixtures"), { recursive: true })
    const tools = await import("../src/tools/proveedor")
    const ctx = { directory: dir, sessionId: "t" }
    await tools.leer_solicitud.execute({ caso: "ec-corp-andina" } as never, ctx)
    const r = await tools.mapear_campos.execute({ caso: "ec-corp-andina" } as never, ctx)
    expect(analizar(r).pide).toBe(true)
  })
})
