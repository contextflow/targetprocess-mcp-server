type Labels = Record<string, string | number | boolean | undefined>

type CounterSample = {
  name: string
  help: string
  labels: Record<string, string>
  value: number
}

type HistogramSample = {
  name: string
  help: string
  labels: Record<string, string>
  buckets: number[]
  counts: number[]
  sum: number
  count: number
}

const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

export class MetricsRegistry {
  private readonly counters = new Map<string, CounterSample>()
  private readonly histograms = new Map<string, HistogramSample>()

  increment(name: string, help: string, labels: Labels = {}, value = 1): void {
    const normalized = normalizeLabels(labels)
    const key = sampleKey(name, normalized)
    const sample = this.counters.get(key) || { name, help, labels: normalized, value: 0 }
    sample.value += value
    this.counters.set(key, sample)
  }

  observeDuration(name: string, help: string, seconds: number, labels: Labels = {}): void {
    const normalized = normalizeLabels(labels)
    const key = sampleKey(name, normalized)
    const sample = this.histograms.get(key) || {
      name,
      help,
      labels: normalized,
      buckets: durationBuckets,
      counts: durationBuckets.map(() => 0),
      sum: 0,
      count: 0,
    }
    for (let index = 0; index < sample.buckets.length; index += 1) {
      if (seconds <= sample.buckets[index]) sample.counts[index] += 1
    }
    sample.sum += seconds
    sample.count += 1
    this.histograms.set(key, sample)
  }

  render(gauges: Record<string, number> = {}): string {
    const lines: string[] = []
    const emittedCounters = new Set<string>()
    for (const sample of [...this.counters.values()].sort(compareSamples)) {
      if (!emittedCounters.has(sample.name)) {
        lines.push(`# HELP ${sample.name} ${sample.help}`)
        lines.push(`# TYPE ${sample.name} counter`)
        emittedCounters.add(sample.name)
      }
      lines.push(`${sample.name}${renderLabels(sample.labels)} ${sample.value}`)
    }

    const emittedHistograms = new Set<string>()
    for (const sample of [...this.histograms.values()].sort(compareSamples)) {
      if (!emittedHistograms.has(sample.name)) {
        lines.push(`# HELP ${sample.name} ${sample.help}`)
        lines.push(`# TYPE ${sample.name} histogram`)
        emittedHistograms.add(sample.name)
      }
      for (let index = 0; index < sample.buckets.length; index += 1) {
        lines.push(`${sample.name}_bucket${renderLabels({ ...sample.labels, le: String(sample.buckets[index]) })} ${sample.counts[index]}`)
      }
      lines.push(`${sample.name}_bucket${renderLabels({ ...sample.labels, le: "+Inf" })} ${sample.count}`)
      lines.push(`${sample.name}_sum${renderLabels(sample.labels)} ${sample.sum}`)
      lines.push(`${sample.name}_count${renderLabels(sample.labels)} ${sample.count}`)
    }

    for (const [name, value] of Object.entries(gauges).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# HELP ${name} Current ${name.replace(/_/g, " ")}.`)
      lines.push(`# TYPE ${name} gauge`)
      lines.push(`${name} ${value}`)
    }

    return `${lines.join("\n")}\n`
  }
}

function normalizeLabels(labels: Labels): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(labels)) {
    if (value === undefined) continue
    normalized[key] = String(value)
  }
  return normalized
}

function sampleKey(name: string, labels: Record<string, string>): string {
  return JSON.stringify([name, Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))])
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return ""
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"")
}

function compareSamples(a: { name: string; labels: Record<string, string> }, b: { name: string; labels: Record<string, string> }): number {
  return sampleKey(a.name, a.labels).localeCompare(sampleKey(b.name, b.labels))
}
