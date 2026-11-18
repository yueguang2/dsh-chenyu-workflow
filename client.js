/** Chenyu workflow settings and session input dock. */
window.__ModuleLoader__.load({
  id: '@local/dsh-chenyu-workflow',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } = React
    const API = '/api/chenyu-workflow'
    const LIBRARY_CHANGED = 'chenyu-workflow:library-changed'
    const OPEN_WORKFLOWS = 'chenyu-workflow:open'
    const list = (value) => Array.isArray(value) ? value : []
    const messageOf = (error) => String(error?.message || error)
    const query = (fields) => new URLSearchParams(Object.entries(fields).filter(([, value]) => value != null)).toString()
    const notifyLibrary = () => window.dispatchEvent(new Event(LIBRARY_CHANGED))
    const noSubscribe = () => () => {}

    const CSS = `
.cy-dock,.cy-settings,.cy-quick-launch{--cy-border:var(--dsw-alias-border-l1);--cy-bg:var(--dsw-alias-bg-layer-2);--cy-input:var(--dsw-alias-bg-layer-3);--cy-muted:var(--dsw-alias-label-secondary);--cy-accent:var(--dsw-alias-state-business-primary);--cy-error:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary,inherit);font-size:13px}
.cy-dock{box-sizing:border-box;width:calc(100% - 2 * var(--dsh-composer-side-clearance,0px) - 2 * var(--dsh-composer-dock-inset,0px));max-width:calc(var(--dsh-composer-card-max-width,760px) - 2 * var(--dsh-composer-dock-inset,0px));margin:0 auto 6px;flex:none;min-width:0}
.cy-settings{width:100%;max-width:720px;display:grid;gap:12px}
.cy-card,.cy-body{background:var(--cy-bg);border:1px solid var(--cy-border);border-radius:12px;padding:12px;min-width:0;display:grid;gap:10px;align-content:start}
.cy-body{max-height:min(52vh,560px);overflow:auto;overscroll-behavior:contain;margin-top:5px}
.cy-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.cy-row>strong,.cy-row>h3,.cy-spread{flex:1;min-width:0;overflow-wrap:anywhere}
.cy-launch{width:100%;justify-content:flex-start;text-align:start;min-height:32px}
.cy-launch-label{flex:1}
.cy-title,.cy-card h3,.cy-body h3{margin:0;font-size:13px;font-weight:650}
.cy-note{color:var(--cy-muted);font-size:12px;line-height:1.45;margin:0;overflow-wrap:anywhere}
.cy-btn,.cy-field input,.cy-field select,.cy-field textarea{box-sizing:border-box;border:1px solid var(--cy-border);border-radius:7px;background:var(--cy-input);color:inherit;font:inherit}
.cy-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:30px;padding:4px 9px;cursor:pointer}
.cy-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--cy-input))}
.cy-btn:disabled{opacity:.55;cursor:default}
.cy-btn[data-primary]{border-color:var(--cy-accent);color:var(--cy-accent);font-weight:650}
.cy-btn[data-danger]{color:var(--cy-error)}
.cy-dock :focus-visible,.cy-settings :focus-visible{outline:2px solid var(--cy-accent);outline-offset:2px}
.cy-field{display:grid;gap:4px;min-width:0;font-weight:500}
.cy-field input,.cy-field select,.cy-field textarea{width:100%;padding:6px 8px;min-height:31px;font-weight:400}
.cy-field textarea{resize:vertical}
.cy-field select option{background:var(--cy-bg);color:var(--dsw-alias-label-primary,inherit)}
.cy-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));gap:8px 10px;align-items:start}
.cy-stack{display:grid;gap:8px;min-width:0}
.cy-rule{border:0;border-top:1px solid var(--cy-border);width:100%;margin:2px 0}
.cy-pill{font-size:11px;color:var(--cy-muted);background:var(--cy-input);border-radius:999px;padding:2px 7px;overflow-wrap:anywhere}
.cy-msg{padding:6px 8px;border-inline-start:2px solid var(--cy-accent);background:var(--cy-input);border-radius:5px;overflow-wrap:anywhere;line-height:1.45}
.cy-msg[data-error]{border-color:var(--cy-error);color:var(--cy-error)}
.cy-danger{color:var(--cy-error)}
.cy-detail>summary{width:fit-content;cursor:pointer;color:var(--cy-muted);margin:2px 0 6px}
.cy-list{margin:0;padding:0;list-style:none;display:grid;gap:5px;min-width:0}
.cy-job,.cy-pod{padding:6px 0;border-top:1px solid var(--cy-border);display:grid;gap:5px;min-width:0}
.cy-job progress{width:100%;height:7px;accent-color:var(--cy-accent)}
.cy-file{color:var(--cy-accent);overflow-wrap:anywhere}
.cy-body form,.cy-settings form{margin:0}
`

    async function request(path, { body, signal } = {}) {
      const response = await fetch(API + path, {
        credentials: 'same-origin', cache: 'no-store', signal,
        ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload || payload.ok === false) {
        throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`)
      }
      return payload
    }

    function useResource(path) {
      const [state, setState] = useState(null)
      const [revision, setRevision] = useState(0)
      const reload = useCallback(() => setRevision((value) => value + 1), [])
      useEffect(() => {
        if (!path) return
        const controller = new AbortController()
        setState((previous) => ({ path, data: previous?.path === path ? previous.data : null, loading: true }))
        const resource = path === '/library' && revision ? `${path}?refresh=1` : path
        request(resource, { signal: controller.signal }).then((data) => {
          if (!controller.signal.aborted) setState({ path, data, loading: false })
        }).catch((error) => {
          if (!controller.signal.aborted) setState((previous) => ({ ...previous, path, error: messageOf(error), loading: false }))
        })
        return () => controller.abort()
      }, [path, revision])
      return { ...(state?.path === path ? state : { loading: Boolean(path) }), reload }
    }

    function useLibrary() {
      const library = useResource('/library')
      useEffect(() => {
        window.addEventListener(LIBRARY_CHANGED, library.reload)
        return () => window.removeEventListener(LIBRARY_CHANGED, library.reload)
      }, [library.reload])
      return library
    }

    const fallback = {
      zh: { launcher: '晨羽智云', loading: '正在加载…', refresh: '刷新', localeError: '无法读取晨羽界面语言资源。' },
      en: { launcher: 'Chenyu Cloud', loading: 'Loading…', refresh: 'Refresh', localeError: 'Could not load Chenyu interface translations.' },
    }
    let localizedCopy
    function useCopy(locale) {
      const readLanguage = useCallback(() => locale?.getLocale?.().active || document.documentElement.lang || 'zh', [locale])
      const subscribeLanguage = useCallback((notify) => locale?.subscribe?.(notify) || noSubscribe(), [locale])
      const language = useSyncExternalStore(subscribeLanguage, readLanguage)
      const lang = /^en(?:[-_]|$)/i.test(language) ? 'en' : 'zh'
      const [remote, setRemote] = useState(null)
      const [retry, setRetry] = useState(0)
      useEffect(() => {
        let mounted = true
        localizedCopy ||= request('/locales').catch((error) => { localizedCopy = undefined; throw error })
        localizedCopy.then((data) => {
          if (mounted) setRemote({ data })
        }).catch(() => {
          if (mounted) setRemote({ error: true })
        })
        return () => { mounted = false }
      }, [retry])
      const dictionaries = remote?.data
      const dict = dictionaries?.[lang]?.ui || dictionaries?.[lang] || dictionaries?.zh?.ui || dictionaries?.zh
      const t = (key, vars = {}) => (dict?.[key] ?? fallback[lang][key] ?? key)
        .replace(/\{([\w]+)\}/g, (match, name) => Object.hasOwn(vars, name) ? String(vars[name]) : match)
      return { t, ready: Boolean(dict), error: remote?.error, retry: () => { setRemote(null); setRetry((value) => value + 1) } }
    }

    function Button({ children, onClick, disabled, tone, type = 'button', ...props }) {
      return h('button', { ...props, className: `cy-btn${props.className ? ` ${props.className}` : ''}`, type, onClick, disabled,
        'data-primary': tone === 'primary' ? '' : undefined, 'data-danger': tone === 'danger' ? '' : undefined }, children)
    }
    const option = (value, text, disabled = false) => h('option', { key: value, value, disabled }, text)
    const field = (label, control) => h('label', { className: 'cy-field' }, h('span', null, label), control)
    const note = (text) => h('p', { className: 'cy-note' }, text)
    const notice = (text, error = false) => text ? h('div', { className: 'cy-msg', role: error ? 'alert' : 'status', 'data-error': error ? '' : undefined }, text) : null
    const pill = (text) => h('span', { className: 'cy-pill' }, text)

    function CopyStatus({ copy }) {
      return copy.error ? h('div', { className: 'cy-row' }, notice(copy.t('localeError'), true),
        h(Button, { onClick: copy.retry }, copy.t('refresh'))) : note(copy.t('loading'))
    }

    function useSessionJobs(sessionId, open) {
      const [state, setState] = useState({})
      const [revision, setRevision] = useState(0)
      const refresh = useCallback(() => setRevision((value) => value + 1), [])
      useEffect(() => {
        if (!sessionId) return
        const controller = new AbortController()
        let timer
        async function poll() {
          let hasWork = false
          try {
            const data = await request(`/jobs?${query({ session_id: sessionId })}`, { signal: controller.signal })
            // Also require the Host's public job ownership marker. A response
            // from an older unscoped route must not expose another session's jobs.
            const scopeMatches = data.session_id === sessionId
            const snapshot = {
              ...data,
              last_shutdown: scopeMatches ? data.last_shutdown : null,
              shutting_down: scopeMatches && data.shutting_down,
            }
            for (const key of ['active', 'queued', 'history']) {
              snapshot[key] = list(data[key]).filter((job) => job?.session_id === sessionId)
            }
            hasWork = Boolean(snapshot.active.length || snapshot.queued.length || snapshot.shutting_down)
            if (!controller.signal.aborted) setState({ snapshot })
          } catch (error) {
            if (!controller.signal.aborted) setState((previous) => ({ ...previous, error: messageOf(error) }))
          } finally {
            if (!controller.signal.aborted) timer = setTimeout(poll, hasWork || open ? 1700 : 6500)
          }
        }
        void poll()
        return () => { controller.abort(); clearTimeout(timer) }
      }, [sessionId, open, revision])
      return { ...state, refresh }
    }

    function useAction() {
      const [busy, setBusy] = useState('')
      const [feedback, setFeedback] = useState(null)
      const lock = useRef(false)
      const run = async (key, task, success) => {
        if (lock.current) return
        lock.current = true
        setBusy(key)
        setFeedback(null)
        try {
          const result = await task()
          if (success) setFeedback({ text: typeof success === 'function' ? success(result) : success })
        } catch (error) {
          setFeedback({ error: true, text: messageOf(error) })
        } finally {
          lock.current = false
          setBusy('')
        }
      }
      return { busy, feedback, run, clear: () => setFeedback(null), fail: (error) => setFeedback({ error: true, text: messageOf(error) }) }
    }

    function gpuId(catalog, saved) {
      const name = typeof saved === 'string' ? saved : saved?.gpu_name
      const id = typeof saved === 'string' ? saved : saved?.gpu_uuid
      return catalog.find((gpu) => gpu.gpu_uuid === id || (name && gpu.gpu_name === name))?.gpu_uuid || ''
    }
    function gpuPrice(gpu, t) {
      return gpu?.price_hour != null && gpu.price_hour !== '' ? t('gpuPrice', { price: gpu.price_hour }) : t('priceUnknown')
    }
    function gpuLabel(gpu, t, current = false) {
      return [gpu.gpu_name || gpu.gpu_uuid, gpu.memory_gb ? `${gpu.memory_gb} GB` : '', gpuPrice(gpu, t),
        t(current ? 'runningGpu' : gpu.available ? 'available' : 'unavailable')].filter(Boolean).join(' · ')
    }
    function instanceLabel(instance) {
      return [instance.title || instance.instance_uuid, instance.image_tag, instance.status_name, instance.gpu_name].filter(Boolean).join(' · ')
    }

    function workflowPayload(draft, workflowName, workflowType, t) {
      const values = { workflow_name: workflowName, workflow_type: workflowType, prompt: draft.prompt }
      for (const [key, label, min, max, integer] of [
        ['seed', 'seed', 0, Number.MAX_SAFE_INTEGER, true], ['duration', 'duration', 1, 15, false], ['megapixels', 'megapixels', Number.MIN_VALUE, Infinity, false],
      ]) {
        if (!draft[key]?.trim()) continue
        const value = Number(draft[key])
        if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
          throw new Error(t('invalidNumber', { field: t(label) }))
        }
        values[key] = value
      }
      for (const key of ['aspect_ratio', 'output_dir']) if (draft[key]?.trim()) values[key] = draft[key].trim()
      for (const [key, label, max] of [['reference_images', 'images', 9], ['reference_videos', 'videos', 3], ['reference_audios', 'audios', 3]]) {
        const paths = draft[key]?.split(/\r?\n/).map((path) => path.trim()).filter(Boolean) || []
        if (paths.length > max) throw new Error(t('tooManyFiles', { field: t(label), max }))
        if (paths.length) values[key] = paths
      }
      for (const key of ['files', 'overrides']) {
        if (!draft[key]?.trim()) continue
        let parsed
        try { parsed = JSON.parse(draft[key]) } catch { /* reported below */ }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('invalidJson', { field: t(key) }))
        values[key] = parsed
      }
      return values
    }

    function AdvancedFields({ draft, setField, t }) {
      const input = (key, label, props) => field(t(label), h('input', { value: draft[key] || '', onChange: setField(key), ...props }))
      const textarea = (key, label, placeholder) => field(t(label), h('textarea', { rows: 2, value: draft[key] || '', onChange: setField(key), placeholder }))
      return h('details', { className: 'cy-detail' }, h('summary', null, t('advanced')),
        h('div', { className: 'cy-stack' },
          h('div', { className: 'cy-grid' },
            input('seed', 'seed', { type: 'number', min: 0, step: 1 }),
            input('duration', 'duration', { type: 'number', min: 1, max: 15, step: 'any' }),
            input('aspect_ratio', 'ratio', { placeholder: '16:9' }),
            input('megapixels', 'megapixels', { type: 'number', min: 0, step: 'any' })),
          note(t('pathsHelp')),
          h('div', { className: 'cy-grid' },
            textarea('reference_images', 'images'), textarea('reference_videos', 'videos'), textarea('reference_audios', 'audios')),
          h('div', { className: 'cy-grid' },
            textarea('files', 'files', '{"49":"assets/reference.png"}'), textarea('overrides', 'overrides', '{"88":{"value":"…"}}')),
          input('output_dir', 'outputDir', { placeholder: 'generated/chenyu' })))
    }

    function JobRow({ job, t, sessionId, busy, act }) {
      const jobId = job.id || job.job_id
      const name = job.kind === 'scan' ? t('scanJob') : job.workflow_label || job.name || job.workflow_name || t('workflow')
      const running = job.status === 'running'
      const cancel = Boolean(jobId && (running || job.status === 'queued'))
      const retry = Boolean(jobId && ['failed', 'cancelled', 'canceled'].includes(job.status))
      const status = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'canceled'].includes(job.status)
        ? t(job.status === 'canceled' ? 'cancelled' : job.status) : job.status || t('unknown')
      const progress = Number(job.progress)
      return h('li', { className: 'cy-job' },
        h('div', { className: 'cy-row' }, h('strong', null, name), pill(status),
          cancel && h(Button, { disabled: Boolean(busy || job.cancel_requested), onClick: () => act('cancel', jobId),
            'aria-label': t('cancelJob', { name }) }, t(job.cancel_requested ? 'cancelling' : 'cancel')),
          retry && h(Button, { disabled: Boolean(busy), onClick: () => act('retry', jobId),
            'aria-label': t('retryJob', { name }) }, t('retryPaid'))),
        running && h('progress', { max: 100, value: Number.isFinite(progress) && progress > 0 ? Math.min(100, progress) : undefined, 'aria-label': t('jobProgress', { name }) }),
        [job.phase_label, job.progress_detail, job.gpu_name].filter(Boolean).length > 0 && note([job.phase_label, job.progress_detail, job.gpu_name].filter(Boolean).join(' · ')),
        job.error && h('p', { className: 'cy-note cy-danger' }, String(job.error)),
        job.shutdown && h('p', { className: `cy-note${job.shutdown.ok ? '' : ' cy-danger'}` }, formatShutdown(job.shutdown, t)),
        ...list(job.warnings).map((warning, index) => h('p', { className: 'cy-note', key: `warning-${index}` }, String(warning?.message || warning))),
        ...list(job.downloaded_files).map((file, index) => {
          const filename = file.filename || file.path?.split(/[\\/]/).pop() || t('outputFile', { index: index + 1 })
          return file.error || !jobId ? h('p', { className: 'cy-note', key: `file-${index}` }, [filename, file.error].filter(Boolean).join(' · '))
            : h('div', { className: 'cy-row', key: `file-${index}` }, h('a', {
                className: 'cy-file', href: `${API}/jobs?${query({ session_id: sessionId, job_id: jobId, file: index })}`,
                download: filename, 'aria-label': t('download', { name: filename }),
              }, filename), file.bytes != null && h('span', { className: 'cy-note' }, t('bytes', { bytes: file.bytes })))
        }))
    }

    function formatShutdown(receipt, t) {
      if (!receipt) return ''
      if (!receipt.ok) return t('shutdownFailed', { error: receipt.error || '' })
      return t('shutdownDone', { time: new Date(receipt.at).toLocaleString() })
    }

    function submitId() {
      return globalThis.crypto?.randomUUID?.() || `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    }

    function WorkflowPanel({ sessionId, jobs, t }) {
      const library = useLibrary()
      const action = useAction()
      const attempt = useRef(null)
      const [modeChoice, setMode] = useState('')
      const [podChoice, setPod] = useState('')
      const [tagChoice, setTag] = useState('')
      const [instanceChoice, setInstance] = useState('')
      const [gpuChoice, setGpu] = useState('')
      const [workflowChoice, setWorkflow] = useState({ key: '', value: '', manual: '' })
      const [draft, setDraft] = useState({ workflow_type: 'auto', prompt: '' })
      const [confirmedScan, setConfirmedScan] = useState('')
      const [acceptedScan, setAcceptedScan] = useState(null)
      const { snapshot } = jobs
      const data = library.data
      const pods = list(data?.pods)
      const instances = list(data?.instances)
      const gpus = list(data?.gpus)
      const mode = modeChoice || (pods.length ? 'pod' : 'instance')
      const pod = pods.find((item) => item.uuid === podChoice) || pods[0]
      const versions = [...new Set([pod?.latest_tag, ...list(pod?.versions).map((item) => item.version_name)].filter(Boolean))]
      const tag = versions.includes(tagChoice) ? tagChoice : versions[0]
      const instance = instances.find((item) => item.instance_uuid === instanceChoice)
        || instances.find((item) => item.instance_uuid === data?.defaultInstanceUuid) || instances[0]
      const source = mode === 'pod' && pod?.uuid && tag ? { pod_uuid: pod.uuid, pod_tag: tag }
        : mode === 'instance' && instance?.instance_uuid ? { instance_uuid: instance.instance_uuid } : null
      const identity = !source?.instance_uuid ? {} : {
        expected_image_tag: instance.image_tag || undefined, expected_pod_uuid: instance.pod_uuid || undefined,
      }
      const sourceKey = source ? query({ ...source, ...identity }) : ''
      const catalog = useResource(sourceKey ? `/workflows?${sourceKey}` : null)
      const selectedSource = source && { ...source, ...(source.instance_uuid ? {
        expected_image_tag: catalog.data?.image_tag || identity.expected_image_tag,
        expected_pod_uuid: catalog.data?.pod_uuid || identity.expected_pod_uuid,
      } : {}) }
      const workflowNames = [...new Set(list(catalog.data?.workflows).map((item) => item?.name).filter(Boolean))]
      const choice = workflowChoice.key === sourceKey ? workflowChoice : { key: sourceKey, value: '', manual: '' }
      const manualValue = '__chenyu_manual__'
      const selectedName = (choice.value === manualValue ? choice.manual : choice.value).trim()
      const inferredType = /moss|文生图|图生图|^(image|img|图片|图像)$/i.test(selectedName) ? 'image'
        : /minimax|h3|视频|video|^vid$/i.test(selectedName) || draft.duration?.trim() || draft.reference_videos?.trim() || draft.reference_audios?.trim()
          || /\.(mp4|mov|webm|avi|mkv|m4v|mp3|wav|flac|m4a|ogg|aac)"/i.test(draft.files || '')
          || /视频|动画|动态|运镜|镜头|video|animate|motion|minimax|h3/i.test(draft.prompt) ? 'video' : 'image'
      const effectiveType = draft.workflow_type === 'auto' ? inferredType : draft.workflow_type
      const current = catalog.data?.instance_uuid ? catalog.data : source?.instance_uuid ? instance : null
      const runningGpu = Number(current?.status) === 2 ? current?.gpu_uuid || '' : ''
      const savedDefault = data?.defaultGpus?.[effectiveType]
      const savedGpu = gpuId(gpus, savedDefault)
      const defaultGpuValue = savedDefault && !savedGpu ? '__missing_default_gpu__' : savedGpu
      const gpuValue = gpuChoice || runningGpu || defaultGpuValue || ''
      const gpuChoices = runningGpu && !gpus.some((item) => item.gpu_uuid === runningGpu)
        ? [...gpus, { gpu_uuid: runningGpu, gpu_name: current.gpu_name }]
        : gpus
      const gpu = gpuChoices.find((item) => item.gpu_uuid === gpuValue)
      const gpuUsable = (item) => item.available || item.gpu_uuid === runningGpu
      const scanKey = gpu ? `${sourceKey}&${query({ gpu: gpu.gpu_uuid, price: gpu.price_hour ?? '' })}` : ''
      const allJobs = [...list(snapshot?.active), ...list(snapshot?.queued), ...list(snapshot?.history)]
      const sameScanSource = (job) => job?.kind === 'scan' && (source?.pod_uuid
        ? job.pod_uuid === source.pod_uuid && job.pod_tag === source.pod_tag
        : Boolean(source?.instance_uuid && !job.pod_uuid && job.instance_uuid === source.instance_uuid))
      const scanInProgress = allJobs.some((job) => sameScanSource(job) && ['queued', 'running'].includes(job.status))
      const scannedJob = list(snapshot?.history).find((job) => job.status === 'succeeded' && (sameScanSource(job)
        || (acceptedScan?.key === sourceKey && acceptedScan?.id && (job.id || job.job_id) === acceptedScan.id)))
      const scanCompletion = scannedJob?.id || scannedJob?.job_id || ''
      const seenScan = useRef('')
      useEffect(() => {
        if (scanCompletion && seenScan.current !== `${sourceKey}/${scanCompletion}`) {
          seenScan.current = `${sourceKey}/${scanCompletion}`
          catalog.reload()
        }
      }, [sourceKey, scanCompletion, catalog.reload])
      useEffect(() => { setConfirmedScan('') }, [scanKey])

      const postJob = (kind, params, success) => {
        if (!sessionId) return
        void action.run(kind, async () => {
          const body = { action: kind, session_id: sessionId, ...params }
          const key = JSON.stringify(body)
          // Keep the request ID when a reply is lost, so trying again cannot
          // enqueue a second copy of the same billable action.
          if (attempt.current?.key !== key) attempt.current = { key, id: submitId() }
          try {
            const result = await request('/jobs', { body: { ...body, request_id: attempt.current.id } })
            attempt.current = null
            if (kind === 'scan') setAcceptedScan({ key: sourceKey, id: result.job?.id || result.job_id })
            return result
          } finally {
            jobs.refresh()
          }
        }, success)
      }
      const canCompute = Boolean(data?.configured && sessionId && source && gpu && gpuUsable(gpu) && !action.busy)
      const setField = (key) => (event) => {
        const value = event.target.value
        setDraft((previous) => ({ ...previous, [key]: value }))
      }
      const runWorkflow = (event) => {
        event.preventDefault()
        if (!canCompute || !selectedName) return
        try {
          const parameters = workflowPayload(draft, selectedName, effectiveType, t)
          postJob('run', { ...selectedSource, gpu: gpu.gpu_uuid, ...parameters }, t('runQueued'))
        } catch (error) {
          action.fail(error)
        }
      }
      const scanWorkflow = () => {
        if (!canCompute || scanInProgress || confirmedScan !== scanKey) return
        setConfirmedScan('')
        postJob('scan', { ...selectedSource, gpu: gpu.gpu_uuid }, t('scanQueued'))
      }
      const jobAction = (kind, jobId) => postJob(kind, { job_id: jobId }, t(kind === 'retry' ? 'retryQueued' : 'cancelRequested'))
      const catalogSource = catalog.data?.source
      const workflowHelp = catalogSource === 'live' ? 'catalogLive' : catalogSource === 'cache' ? 'catalogCache' : 'catalogMissing'

      return h(React.Fragment, null,
        h('div', { className: 'cy-row' }, h('h3', null, t('newWorkflow')),
          h(Button, { onClick: library.reload, disabled: library.loading }, t('refreshSources'))),
        library.error && notice(library.error, true),
        !data && library.loading && note(t('loading')),
        ...list(data?.warnings).map((warning, index) => h('p', { key: index, className: 'cy-note' }, String(warning?.message || warning))),
        data && !data.configured && notice(t('configureInSettings')),
        !sessionId && notice(t('noSession')),
        data?.configured && h('form', { className: 'cy-stack', onSubmit: runWorkflow },
          h('div', { className: 'cy-grid' },
            field(t('source'), h('select', { value: mode, onChange: (event) => setMode(event.target.value) },
              option('pod', t('podSource')), option('instance', t('instanceSource')))),
            mode === 'pod' ? h(React.Fragment, null,
              field(t('pod'), h('select', { value: pod?.uuid || '', onChange: (event) => { setPod(event.target.value); setTag('') } },
                !pods.length && option('', t('noPods')), ...pods.map((item) => option(item.uuid, item.title || item.uuid)))),
              field(t('version'), h('select', { value: tag || '', onChange: (event) => setTag(event.target.value) },
                !versions.length && option('', t('noVersions')), ...versions.map((version) => option(version, version === pod?.latest_tag ? t('latestVersion', { version }) : version)))))
              : field(t('instance'), h('select', { value: instance?.instance_uuid || '', onChange: (event) => setInstance(event.target.value) },
                  !instances.length && option('', t('noInstances')), ...instances.map((item) => option(item.instance_uuid, instanceLabel(item)))))),
          mode === 'pod' && !pods.length && note(t('savePodFirst')),
          source && h(React.Fragment, null,
            h('div', { className: 'cy-row' }, pill(t(catalog.loading ? 'catalogLoading' : workflowHelp)),
              catalog.data?.status_name && pill(catalog.data.status_name),
              mode === 'instance' && catalog.data?.image_tag && pill(catalog.data.image_tag),
              h(Button, { onClick: catalog.reload, disabled: catalog.loading }, t('refreshCatalog'))),
            catalog.error && notice(catalog.error, true),
            catalog.data?.message && note(catalog.data.message),
            catalog.data && !catalog.loading && !workflowNames.length && catalogSource !== 'unavailable' && note(t('catalogEmpty')),
            h('div', { className: 'cy-grid' },
              field(t('workflow'), h('select', { value: choice.value,
                onChange: (event) => setWorkflow({ ...choice, value: event.target.value }) },
                option('', t('chooseWorkflow')), ...workflowNames.map((name) => option(name, name)),
                choice.value && choice.value !== manualValue && !workflowNames.includes(choice.value) && option(choice.value, t('previousFile', { name: choice.value })),
                option(manualValue, t('manualWorkflow')))),
              field(t('workflowType'), h('select', { value: draft.workflow_type, onChange: setField('workflow_type') },
                option('auto', t('autoType')), option('image', t('imageType')), option('video', t('videoType'))))),
            choice.value === manualValue && field(t('filenameAlias'), h('input', { value: choice.manual, placeholder: 'workflow.json / MOSS / H3',
              onChange: (event) => setWorkflow({ ...choice, manual: event.target.value }) })),
            field(t('gpu'), h('select', { value: gpuValue, onChange: (event) => setGpu(event.target.value) },
              option('', t('chooseGpu')),
               gpuValue === '__missing_default_gpu__' && option(gpuValue, t('defaultUnknownGpu'), true),
               gpuChoice && !gpu && option(gpuChoice, t('unknownGpu'), true),
              ...gpuChoices.map((item) => option(item.gpu_uuid, gpuLabel(item, t, item.gpu_uuid === runningGpu), !gpuUsable(item))))),
            gpu && !gpuUsable(gpu) && note(t('noGpuCapacity')),
            confirmedScan && confirmedScan === scanKey
              ? h('div', { className: 'cy-msg cy-stack' }, note(t('scanFee', { price: gpuPrice(gpu, t) })),
                  h('div', { className: 'cy-row' }, h(Button, { tone: 'primary', disabled: !canCompute || scanInProgress, onClick: scanWorkflow }, t('confirmScan')),
                    h(Button, { onClick: () => setConfirmedScan('') }, t('back'))))
              : h('div', { className: 'cy-row' }, h(Button, { disabled: !canCompute || scanInProgress, onClick: () => setConfirmedScan(scanKey) },
                  t(scanInProgress ? 'scanPending' : 'scanPaid'))),
            field(t('prompt'), h('textarea', { rows: 2, value: draft.prompt, placeholder: t('promptHint'), onChange: setField('prompt') })),
            h(AdvancedFields, { draft, setField, t }),
            h('div', { className: 'cy-row' }, h(Button, { type: 'submit', tone: 'primary', disabled: !canCompute || !selectedName }, t(action.busy === 'run' ? 'submitting' : 'runPaid')),
              note(t('runFee', { price: gpuPrice(gpu, t) }))))),
        action.feedback && notice(action.feedback.text, action.feedback.error),
        h('hr', { className: 'cy-rule' }),
        h('div', { className: 'cy-row' }, h('h3', null, t('sessionJobs')), h(Button, { onClick: jobs.refresh, disabled: !sessionId }, t('refreshJobs'))),
        jobs.error && notice(jobs.error, true),
        sessionId && !jobs.error && !snapshot && note(t('loading')),
        snapshot && !allJobs.length && note(t('noJobs')),
        allJobs.length > 0 && h('ul', { className: 'cy-list' }, allJobs.map((job) => h(JobRow, { key: job.id || job.job_id, job, t, sessionId, busy: action.busy, act: jobAction }))),
        snapshot?.shutting_down ? note(t('shuttingDown'))
          : (snapshot || data) && note(
          t((snapshot?.auto_shutdown ?? data?.autoShutdown) ? 'autoShutdown' : 'autoShutdownOff')))
    }

    function Dock({ sessionId, locale }) {
      const [open, setOpen] = useState(false)
      const controlId = useId()
      const copy = useCopy(locale)
      const { t } = copy
      const jobs = useSessionJobs(sessionId, open)
      useEffect(() => {
        const show = (event) => { if (event.detail === sessionId) setOpen(true) }
        window.addEventListener(OPEN_WORKFLOWS, show)
        return () => window.removeEventListener(OPEN_WORKFLOWS, show)
      }, [sessionId])
      const { snapshot } = jobs
      const active = list(snapshot?.active)
      const queued = list(snapshot?.queued)
      const latest = active[0] || queued[0] || list(snapshot?.history)[0]
      const count = active.length + queued.length
      const jobStatus = active[0]?.phase_label || t(latest?.status || 'unknown')
      const shutdown = snapshot?.shutting_down ? t('shuttingDown') : formatShutdown(latest?.shutdown, t)
      const status = copy.ready && (count ? t('dockWork', { count, status: jobStatus })
        : [latest && jobStatus, shutdown].filter(Boolean).join(' · '))
      if (!open && !status) return null
      return h('div', { className: 'cy-dock' },
        h(Button, { className: 'cy-launch', 'aria-expanded': open, 'aria-controls': controlId, onClick: () => setOpen((value) => !value) },
          h('span', { className: 'cy-launch-label' }, t('launcher')), status && pill(status),
          h('span', { 'aria-hidden': true }, open ? '▴' : '▾')),
        h('section', { className: open ? 'cy-body' : undefined, id: controlId, hidden: !open, 'aria-label': t('launcher') },
          open && (copy.ready ? h(WorkflowPanel, { sessionId, jobs, t }) : h(CopyStatus, { copy }))))
    }

    function HookDock({ useSession, locale }) {
      const sessionId = String(useSession((state) => state.sessionId) || '')
      return h(Dock, { key: sessionId, sessionId, locale })
    }

    function PodUpdate({ instances, defaultInstanceUuid, t }) {
      const [selection, setSelection] = useState('')
      const [check, setCheck] = useState(null)
      const [confirm, setConfirm] = useState(false)
      const action = useAction()
      const instanceUuid = instances.find((item) => item.instance_uuid === selection)?.instance_uuid
        || instances.find((item) => item.instance_uuid === defaultInstanceUuid)?.instance_uuid || instances[0]?.instance_uuid || ''
      const result = check?.instanceUuid === instanceUuid ? check.data : null
      const canApply = result?.update_available && result.mode === 'create_instance' && result.latest_tag
      const checkVersion = () => void action.run('check', async () => {
        setCheck(null)
        setConfirm(false)
        const data = await request(`/pod-update?${query({ instance_uuid: instanceUuid })}`)
        setCheck({ instanceUuid, data })
      })
      const applyVersion = () => {
        if (!confirm || !canApply) return
        setConfirm(false)
        void action.run('apply', async () => {
          const data = await request('/pod-update', { body: {
            action: 'apply', instance_uuid: instanceUuid, expected_tag: result.latest_tag,
            expected_current_tag: result.current_tag, mode: 'create_instance',
          } })
          setCheck(null)
          notifyLibrary()
          return data
        }, (data) => data.message || t('updateApplied'))
      }
      return h('section', { className: 'cy-card' }, h('h3', null, t('podUpdate')),
        field(t('instance'), h('select', { value: instanceUuid, disabled: Boolean(action.busy), onChange: (event) => {
          setSelection(event.target.value); setCheck(null); setConfirm(false); action.clear()
        } }, !instances.length && option('', t('noInstances')), ...instances.map((item) => option(item.instance_uuid, instanceLabel(item))))),
        h('div', { className: 'cy-row' }, h(Button, { disabled: !instanceUuid || Boolean(action.busy), onClick: checkVersion }, t('checkVersion')),
          action.busy && note(t(action.busy === 'apply' ? 'applying' : 'loading'))),
        result && h(React.Fragment, null,
          h('div', { className: 'cy-row' }, pill(t('currentTag', { tag: result.current_tag || '—' })), pill(t('latestTag', { tag: result.latest_tag || '—' }))),
          note(result.message || t(result.update_available ? canApply ? 'updateFound' : 'updateCannotApply' : 'upToDate')),
          canApply && (confirm ? h('div', { className: 'cy-msg cy-stack' }, note(t('createHelp', { tag: result.latest_tag })),
            h('div', { className: 'cy-row' }, h(Button, { tone: 'primary', disabled: Boolean(action.busy), onClick: applyVersion }, t('confirmCreate')),
              h(Button, { onClick: () => setConfirm(false) }, t('back'))))
            : h('div', { className: 'cy-row' }, h(Button, { disabled: Boolean(action.busy), onClick: () => setConfirm(true) }, t('createVersion'))))),
        action.feedback && notice(action.feedback.text, action.feedback.error))
    }

    function SettingsContent({ t }) {
      const library = useLibrary()
      const action = useAction()
      const [apiKey, setApiKey] = useState('')
      const [podUuid, setPodUuid] = useState('')
      const [test, setTest] = useState(null)
      const [defaultInstance, setDefaultInstance] = useState(null)
      const [defaultImage, setDefaultImage] = useState(null)
      const [defaultVideo, setDefaultVideo] = useState(null)
      const data = library.data
      const configured = Boolean(data?.configured)
      const writable = Boolean(data && data.writable !== false)
      const pods = list(data?.pods)
      const instances = list(data?.instances)
      const gpus = list(data?.gpus)
      const instanceValue = defaultInstance ?? data?.defaultInstanceUuid ?? ''
      const busy = Boolean(action.busy)
      const modify = (key, route, body, onSuccess) => void action.run(key, async () => {
        await request(route, { body })
        onSuccess?.()
        notifyLibrary()
      }, t('saved'))
      const gpuSetting = (type, current, setCurrent) => {
        const saved = data?.defaultGpus?.[type]
        const savedId = gpuId(gpus, saved)
        const fallbackName = typeof saved === 'string' ? saved : saved?.gpu_name || saved?.gpu_uuid
        const value = current ?? savedId
        return h('div', { className: 'cy-row' }, h('div', { className: 'cy-spread' }, field(t(type === 'image' ? 'defaultImage' : 'defaultVideo'),
          h('select', { value, onChange: (event) => setCurrent(event.target.value) },
            option('', fallbackName && !savedId ? t('defaultWithName', { name: fallbackName }) : t('defaultGpuPlaceholder')),
            ...gpus.map((gpu) => option(gpu.gpu_uuid, gpuLabel(gpu, t)))))),
          h(Button, { onClick: () => modify(type, '/settings', { [type === 'image' ? 'defaultGpuImage' : 'defaultGpuVideo']: value }, () => setCurrent(null)),
            disabled: busy || !configured || current === null }, t('save')))
      }
      return h(React.Fragment, null,
        h('div', { className: 'cy-row' }, h('h2', { className: 'cy-title cy-spread' }, t('settingsTitle')),
          h(Button, { onClick: library.reload, disabled: library.loading }, t('refresh'))),
        library.error && notice(library.error, true),
        library.loading && !data && note(t('loading')),
        ...list(data?.warnings).map((warning, index) => h('p', { className: 'cy-note', key: index }, String(warning?.message || warning))),
        action.feedback && notice(action.feedback.text, action.feedback.error),
        h('section', { className: 'cy-card' },
          h('div', { className: 'cy-row' }, h('h3', null, t('credentials')), data && pill(t(configured ? 'keySet' : 'keyMissing'))),
          data && !writable && note(t('keyReadOnly')),
          h('form', { className: 'cy-stack', onSubmit: (event) => { event.preventDefault(); if (writable && !busy && apiKey.trim()) {
            modify('key', '/settings', { apiKey: apiKey.trim() }, () => { setApiKey(''); setTest(null) })
          } } }, field(t('apiKey'), h('input', { type: 'password', autoComplete: 'new-password', spellCheck: false,
            value: apiKey, disabled: busy || !writable, onChange: (event) => setApiKey(event.target.value) })),
          h('div', { className: 'cy-row' }, h(Button, { type: 'submit', tone: 'primary', disabled: !writable || busy || !apiKey.trim() }, t('saveKey')),
            configured && h(Button, { disabled: !writable || busy, tone: 'danger', onClick: () => modify('clear', '/settings', { clear: true }, () => { setApiKey(''); setTest(null) }) }, t('clearKey')),
            h(Button, { disabled: !configured || busy, onClick: () => void action.run('test', async () => {
              setTest(null); setTest(await request('/test'))
            }, t('testOk')) }, t('testConnection')))),
          test && note(t('balance', { amount: test.balance?.balance ?? '—', currency: test.balance?.currency || 'CNY', card: test.balance?.card_balance ?? '—' }))),
        h('section', { className: 'cy-card' }, h('h3', null, t('defaults')),
          h('div', { className: 'cy-row' }, h('div', { className: 'cy-spread' }, field(t('defaultInstance'),
            h('select', { value: instanceValue, onChange: (event) => setDefaultInstance(event.target.value) }, option('', t('noDefault')),
              instanceValue && !instances.some((item) => item.instance_uuid === instanceValue) && option(instanceValue, instanceValue),
              ...instances.map((item) => option(item.instance_uuid, instanceLabel(item)))))),
            h(Button, { disabled: busy || !configured || defaultInstance === null,
              onClick: () => modify('instance', '/settings', { defaultInstanceUuid: instanceValue }, () => setDefaultInstance(null)) }, t('save'))),
          gpuSetting('image', defaultImage, setDefaultImage), gpuSetting('video', defaultVideo, setDefaultVideo),
          data && note(t(data.autoShutdown ? 'autoShutdown' : 'autoShutdownOff'))),
        h('section', { className: 'cy-card' }, h('h3', null, t('podLibrary')), note(t('libraryHelp')),
          h('form', { className: 'cy-stack', onSubmit: (event) => { event.preventDefault(); if (configured && !busy && podUuid.trim()) {
            modify('add', '/library', { action: 'save_pod', pod_uuid: podUuid.trim() }, () => setPodUuid(''))
          } } }, field(t('podUuid'), h('input', { value: podUuid, onChange: (event) => setPodUuid(event.target.value), spellCheck: false })),
          h('div', { className: 'cy-row' }, h(Button, { type: 'submit', tone: 'primary', disabled: !configured || busy || !podUuid.trim() }, t('addPod')))),
          data && !pods.length && note(t('noPods')),
          pods.length > 0 && h('ul', { className: 'cy-list' }, pods.map((pod) => h('li', { className: 'cy-pod', key: pod.uuid },
            h('div', { className: 'cy-row' }, h('strong', null, pod.title || pod.uuid), pod.latest_tag && pill(t('latestTag', { tag: pod.latest_tag })),
              h(Button, { disabled: busy, tone: 'danger', 'aria-label': t('removeNamedPod', { name: pod.title || pod.uuid }),
                onClick: () => modify('remove', '/library', { action: 'remove_pod', pod_uuid: pod.uuid }) }, t('removePod'))),
            pod.title && note(pod.uuid),
            list(pod.versions).length > 0 && h('details', { className: 'cy-detail' }, h('summary', null, t('versions', { count: pod.versions.length })),
              h('ul', { className: 'cy-list' }, pod.versions.map((version) => h('li', { className: 'cy-note', key: version.version_name },
                [version.version_name, version.version_updated_at, version.version_size].filter(Boolean).join(' · '))))))))),
        h(PodUpdate, { instances, defaultInstanceUuid: data?.defaultInstanceUuid, t }))
    }

    function SettingsPanel({ locale }) {
      const copy = useCopy(locale)
      return h('div', { className: 'cy-settings' }, copy.ready ? h(SettingsContent, { t: copy.t }) : h(CopyStatus, { copy }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get?.('slots') || ctx.slots
        const locale = ctx.get?.('locale')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-chenyu-workflow')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'chenyu-workflow: client styles')
        slots.inject('settings.section', () => {
          const register = () => slots.register({ name: 'settings.section', id: 'chenyu-workflow', order: 25,
            label: locale?.resolveText?.({ zh: '晨羽智云', en: 'Chenyu Cloud' }) || '晨羽智云' }, () => h(SettingsPanel, { locale }))
          let activeLanguage = locale?.getLocale?.().active
          let dispose = register()
          const unsubscribe = locale?.subscribe?.(() => {
            const next = locale.getLocale().active
            if (next === activeLanguage) return
            activeLanguage = next
            dispose?.()
            dispose = register()
          })
          return () => { unsubscribe?.(); dispose?.() }
        })
        slots.inject('conversation.input.left', () => slots.register(
          { name: 'conversation.input.left', id: 'chenyu-launcher', order: 21 },
          function WorkflowLauncher({ sessionId }) {
            const { t } = useCopy(locale)
            if (!sessionId) return null
            return h('span', { className: 'cy-quick-launch' }, h(Button, { onClick: () => {
              window.dispatchEvent(new CustomEvent(OPEN_WORKFLOWS, { detail: String(sessionId) }))
            } }, t('launcher')))
          },
        ))
        slots.inject('conversation.input.dock', () => slots.register(
          { name: 'conversation.input.dock', id: 'chenyu-queue', order: 21 },
          function SessionWorkflowDock({ sessionId, useSession }) {
            if (sessionId) return h(Dock, { key: sessionId, sessionId: String(sessionId), locale })
            if (typeof useSession === 'function') return h(HookDock, { useSession, locale })
            return h(Dock, { sessionId: '', locale })
          },
        ))
      },
    }
  },
})
