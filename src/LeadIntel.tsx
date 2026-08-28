import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  AlertCircle,
  Building2,
  Check,
  Clock3,
  Copy,
  Database,
  ExternalLink,
  Globe2,
  LoaderCircle,
  MapPin,
  Search,
  ShieldCheck,
  Mail,
  Phone,
  Users,
} from 'lucide-react'

type SearchKind = 'lead' | 'cnpj' | 'domain' | 'company'
type ProviderState = { name: string; status: 'ok' | 'not_found' | 'unconfigured' | 'error'; detail: string }
type Source = { title: string; url: string; provider: string; checked_at: string }
type WebResult = { title: string; url: string; description: string; domain: string }
type ResearchResult = {
  research_id: string
  searched_at: string
  query_type: SearchKind
  company: {
    legal_name?: string
    trade_name?: string
    cnpj?: string
    registration_status?: string
    opened_at?: string
    size?: string
    primary_activity?: string
    secondary_activities?: string[]
    address?: string
    city?: string
    state?: string
    postal_code?: string
    legal_nature?: string
    capital_social?: number
    branch_type?: string
    business_email?: string
    business_phone_1?: string
    business_phone_2?: string
    partners?: { name: string; role?: string; joined_at?: string; entity_type?: string }[]
  } | null
  website: {
    url: string
    title?: string
    description?: string
    social_links: { label: string; url: string }[]
  } | null
  web_results: WebResult[]
  sources: Source[]
  providers: ProviderState[]
  warnings: string[]
  detected_type?: Exclude<SearchKind, 'lead'>
}

const kinds: { value: SearchKind; label: string; placeholder: string; hint: string }[] = [
  { value: 'lead', label: 'Dado do lead', placeholder: 'Cole o nome, empresa, CNPJ ou domínio que veio no card', hint: 'Identificação automática do melhor caminho' },
  { value: 'cnpj', label: 'CNPJ', placeholder: '00.000.000/0001-00', hint: 'Consulta cadastral empresarial' },
  { value: 'domain', label: 'Domínio', placeholder: 'empresa.com.br', hint: 'Site e presença digital pública' },
  { value: 'company', label: 'Nome/contexto', placeholder: 'Nome do contato + empresa ou cidade', hint: 'Pesquisa pública por contexto' },
]

const purposes = [
  'Qualificação de lead B2B recebido',
  'Preparação de atendimento solicitado',
  'Atualização cadastral de cliente',
  'Prevenção de duplicidade no CRM',
]

function formatDate(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short', timeStyle: 'short',
  }).format(date)
}

function formatMoney(value?: number) {
  if (!value) return '—'
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value)
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return <div className="intel-field"><span>{label}</span><strong>{value}</strong></div>
}

function LeadIntel() {
  const [kind, setKind] = useState<SearchKind>('lead')
  const [query, setQuery] = useState('')
  const [purpose, setPurpose] = useState(purposes[0])
  const [justification, setJustification] = useState('')
  const [authorized, setAuthorized] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ResearchResult | null>(null)
  const [copied, setCopied] = useState(false)

  const selectedKind = useMemo(() => kinds.find((item) => item.value === kind)!, [kind])
  const canSearch = query.trim().length >= 3 && justification.trim().length >= 10 && authorized && !loading

  function changeKind(nextKind: SearchKind) {
    setKind(nextKind)
    setQuery('')
    setError('')
    setResult(null)
  }

  async function research(event: FormEvent) {
    event.preventDefault()
    if (!canSearch) return
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const response = await fetch('/api/leads/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query.trim(),
          query_type: kind,
          purpose,
          justification: justification.trim(),
          authorized,
        }),
      })
      const responseText = await response.text()
      let payload: Partial<ResearchResult> & { detail?: string | { msg?: string }[] } = {}
      try {
        payload = responseText ? JSON.parse(responseText) : {}
      } catch {
        throw new Error('A API não respondeu corretamente. Verifique se o backend está ligado na VPS.')
      }
      if (!response.ok) {
        const detail = Array.isArray(payload.detail) ? payload.detail.map((item) => item.msg).filter(Boolean).join(', ') : payload.detail
        throw new Error(detail || 'A pesquisa não pôde ser concluída.')
      }
      setResult(payload as ResearchResult)
    } catch (researchError) {
      setError(researchError instanceof Error ? researchError.message : 'A pesquisa não pôde ser concluída.')
    } finally {
      setLoading(false)
    }
  }

  async function copySummary() {
    if (!result) return
    const company = result.company
    const lines = [
      `Pesquisa F5 Lead Intel — ${formatDate(result.searched_at)}`,
      company?.trade_name || company?.legal_name || query,
      company?.cnpj ? `CNPJ: ${company.cnpj}` : '',
      company?.registration_status ? `Situação: ${company.registration_status}` : '',
      company?.primary_activity ? `Atividade: ${company.primary_activity}` : '',
      company?.city ? `Localização: ${company.city}/${company.state || ''}` : '',
      company?.business_phone_1 ? `Telefone comercial: ${company.business_phone_1}` : '',
      company?.business_email ? `E-mail cadastral: ${company.business_email}` : '',
      company?.partners?.length ? `Sócios/administradores: ${company.partners.length}` : '',
      result.website?.url ? `Site: ${result.website.url}` : '',
      `Fontes verificadas: ${result.sources.length}`,
      `ID da pesquisa: ${result.research_id}`,
    ].filter(Boolean)
    await navigator.clipboard.writeText(lines.join('\n'))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="intel-page" id="lead-intel">
      <section className="intel-hero">
        <div>
          <div className="eyebrow"><span /> Inteligência comercial responsável</div>
          <h1>Conheça a empresa.<br /><em>Respeite a pessoa.</em></h1>
          <p>Parta de qualquer dado que já veio no card do Kommo, encontre contexto público sobre o lead e complete o cadastro com revisão humana.</p>
        </div>
        <div className="intel-trust">
          <ShieldCheck size={25} />
          <div><strong>LGPD desde o desenho</strong><span>Finalidade, minimização, fontes e auditoria.</span></div>
        </div>
      </section>

      <section className="intel-layout" aria-label="Pesquisa empresarial">
        <form className="intel-search-card" onSubmit={research}>
          <div className="intel-card-heading">
            <div><span className="heading-index">01</span><div><strong>Nova pesquisa</strong><small>Somente contexto empresarial legítimo</small></div></div>
            <span className="online-status"><i /> API protegida</span>
          </div>

          <div className="intel-form-body">
            <div className="intel-kind-grid" role="radiogroup" aria-label="Tipo de pesquisa">
              {kinds.map((item) => (
                <button key={item.value} type="button" role="radio" aria-checked={kind === item.value} className={kind === item.value ? 'selected' : ''} onClick={() => changeKind(item.value)}>
                  <span>{item.label}</span><small>{item.hint}</small>
                  {kind === item.value && <i><Check size={11} /></i>}
                </button>
              ))}
            </div>

            <label className="intel-label">
              <span>{selectedKind.label}</span>
              <div className="intel-input"><Search size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={selectedKind.placeholder} autoComplete="off" /></div>
              {kind === 'lead' && <small>Ex.: “ACME Comércio, Campinas”, CNPJ ou acme.com.br. Não use CPF, telefone isolado ou e-mail pessoal.</small>}
            </label>

            <label className="intel-label">
              <span>Finalidade da consulta</span>
              <select value={purpose} onChange={(event) => setPurpose(event.target.value)}>
                {purposes.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>

            <label className="intel-label">
              <span>Justificativa operacional</span>
              <textarea value={justification} onChange={(event) => setJustification(event.target.value)} placeholder="Ex.: lead solicitou contato comercial pelo formulário do cliente." maxLength={300} />
              <small>{justification.length}/300 · mínimo de 10 caracteres</small>
            </label>

            <label className="intel-consent">
              <input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} />
              <span>Confirmo que esta pesquisa tem finalidade profissional legítima e não será usada para buscar dados pessoais sensíveis.</span>
            </label>

            {error && <div className="intel-error" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}

            <button className="intel-submit" type="submit" disabled={!canSearch}>
              {loading ? <><LoaderCircle className="spinning" size={19} /> Consultando fontes…</> : <><Search size={19} /> Pesquisar lead</>}
            </button>
            <p className="intel-legal-note">Não substitui avaliação jurídica. Dados públicos também exigem finalidade, necessidade e transparência.</p>
          </div>
        </form>

        <section className={`intel-results ${result ? 'has-result' : ''}`} aria-live="polite">
          {!result && !loading ? (
            <div className="intel-empty">
              <span><Building2 size={31} /></span>
              <strong>Comece pelo dado que você já tem</strong>
              <p>Cole um nome, empresa, cidade, CNPJ ou domínio do card. O sistema identifica o melhor caminho e mostra os dados públicos encontrados com as fontes.</p>
              <div><Database size={15} /> Cadastro público <i /> <Globe2 size={15} /> Web aberta <i /> <ShieldCheck size={15} /> Fontes visíveis</div>
            </div>
          ) : loading ? (
            <div className="intel-empty intel-loading"><span><LoaderCircle className="spinning" size={31} /></span><strong>Verificando fontes públicas</strong><p>Estamos consultando apenas os provedores necessários para esta finalidade.</p></div>
          ) : result && (
            <div className="intel-result-stack">
              <header className="intel-result-header">
                <div><span>Pesquisa concluída{result.detected_type ? ` · ${result.detected_type === 'cnpj' ? 'CNPJ' : result.detected_type === 'domain' ? 'domínio' : 'nome/contexto'}` : ''}</span><h2>{result.company?.trade_name || result.company?.legal_name || result.website?.title || query}</h2><p><Clock3 size={13} /> {formatDate(result.searched_at)} · ID {result.research_id.slice(0, 8)}</p></div>
                <button type="button" onClick={copySummary}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? 'Copiado' : 'Copiar resumo'}</button>
              </header>

              {result.warnings.length > 0 && <div className="intel-warning"><AlertCircle size={18} /><div>{result.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div></div>}

              {result.company && <article className="intel-section">
                <div className="intel-section-title"><Building2 size={18} /><div><strong>Cadastro empresarial</strong><span>Dados selecionados e minimizados</span></div></div>
                <div className="intel-fields">
                  <Field label="Razão social" value={result.company.legal_name} />
                  <Field label="Nome fantasia" value={result.company.trade_name} />
                  <Field label="CNPJ" value={result.company.cnpj} />
                  <Field label="Situação" value={result.company.registration_status} />
                  <Field label="Porte" value={result.company.size} />
                  <Field label="Abertura" value={result.company.opened_at} />
                  <Field label="Atividade principal" value={result.company.primary_activity} />
                  <Field label="Localização" value={[result.company.city, result.company.state].filter(Boolean).join(' / ')} />
                  <Field label="Natureza jurídica" value={result.company.legal_nature} />
                  <Field label="Capital social" value={result.company.capital_social ? formatMoney(result.company.capital_social) : undefined} />
                  <Field label="Tipo de estabelecimento" value={result.company.branch_type} />
                </div>
                {result.company.address && <div className="intel-address"><MapPin size={15} /><span>{result.company.address}{result.company.postal_code ? ` · CEP ${result.company.postal_code}` : ''}</span></div>}
                {(result.company.business_phone_1 || result.company.business_phone_2 || result.company.business_email) && <div className="intel-contact-grid">
                  {result.company.business_phone_1 && <a href={`tel:${result.company.business_phone_1}`}><Phone size={14} /><span><small>Telefone comercial</small><strong>{result.company.business_phone_1}</strong></span></a>}
                  {result.company.business_phone_2 && <a href={`tel:${result.company.business_phone_2}`}><Phone size={14} /><span><small>Telefone comercial 2</small><strong>{result.company.business_phone_2}</strong></span></a>}
                  {result.company.business_email && <a href={`mailto:${result.company.business_email}`}><Mail size={14} /><span><small>E-mail cadastral</small><strong>{result.company.business_email}</strong></span></a>}
                </div>}
                {result.company.partners?.length ? <div className="intel-partners"><div className="intel-subtitle"><Users size={15} /><strong>Sócios e administradores publicados</strong><span>Não inclui CPF ou dados de contato pessoais</span></div>{result.company.partners.map((partner) => <div key={`${partner.name}-${partner.role}`}><strong>{partner.name}</strong><span>{[partner.role, partner.entity_type, partner.joined_at ? `desde ${partner.joined_at}` : ''].filter(Boolean).join(' · ')}</span></div>)}</div> : null}
              </article>}

              {result.website && <article className="intel-section">
                <div className="intel-section-title"><Globe2 size={18} /><div><strong>Site oficial informado</strong><span>Metadados da página pública</span></div></div>
                <a className="intel-website" href={result.website.url} target="_blank" rel="noreferrer"><div><strong>{result.website.title || result.website.url}</strong><span>{result.website.description || 'Descrição não encontrada na página.'}</span></div><ExternalLink size={17} /></a>
                {result.website.social_links.length > 0 && <div className="intel-socials">{result.website.social_links.map((social) => <a key={social.url} href={social.url} target="_blank" rel="noreferrer">{social.label}<ExternalLink size={12} /></a>)}</div>}
              </article>}

              {result.web_results.length > 0 && <article className="intel-section">
                <div className="intel-section-title"><Search size={18} /><div><strong>Resultados públicos</strong><span>Confirme antes de usar no CRM</span></div></div>
                <div className="intel-web-list">{result.web_results.map((item) => <a key={item.url} href={item.url} target="_blank" rel="noreferrer"><div><small>{item.domain}</small><strong>{item.title}</strong><span>{item.description}</span></div><ExternalLink size={16} /></a>)}</div>
              </article>}

              <article className="intel-section">
                <div className="intel-section-title"><Database size={18} /><div><strong>Provedores consultados</strong><span>Status transparente da pesquisa</span></div></div>
                <div className="intel-provider-list">{result.providers.map((provider) => <div key={provider.name}><i className={`status-${provider.status}`} /><div><strong>{provider.name}</strong><span>{provider.detail}</span></div></div>)}</div>
              </article>

              <article className="intel-section intel-sources">
                <div className="intel-section-title"><ShieldCheck size={18} /><div><strong>Fontes e rastreabilidade</strong><span>{result.sources.length} fonte(s) usada(s)</span></div></div>
                {result.sources.length ? result.sources.map((source) => <a key={`${source.provider}-${source.url}`} href={source.url} target="_blank" rel="noreferrer"><div><strong>{source.title}</strong><span>{source.provider} · verificada em {formatDate(source.checked_at)}</span></div><ExternalLink size={15} /></a>) : <p>Nenhuma fonte confirmou dados para esta consulta.</p>}
              </article>
            </div>
          )}
        </section>
      </section>
    </div>
  )
}

export default LeadIntel
