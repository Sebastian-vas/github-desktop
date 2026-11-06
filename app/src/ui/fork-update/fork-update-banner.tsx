import * as React from 'react'
import { IpcRendererEvent } from 'electron'
import { Banner } from '../banners/banner'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { LinkButton } from '../lib/link-button'
import { Loading } from '../lib/loading'
import { invoke, on, removeListener } from '../../lib/ipc-renderer'
import {
  ForkUpdateMethod,
  IForkUpdate,
  methodNeedsPassword,
} from '../../lib/fork-update'
import {
  CheckForUpdatesNowEvent,
  getForkUpdateMode,
} from '../../lib/fork-update-settings'

type Status =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'
  | 'up-to-date'

interface IForkUpdateBannerProps {
  readonly onOpenUrl: (url: string) => void
}

interface IForkUpdateBannerState {
  readonly status: Status
  readonly update: IForkUpdate | null
  readonly method: ForkUpdateMethod
  readonly current: string
  readonly progress: number
  readonly error: string | null
  /** The user closed the banner for this version */
  readonly dismissedVersion: string | null
}

/**
 * Keeps this fork up to date from its GitHub releases: checks for new
 * versions, downloads them (automatically or when asked) and installs them
 * on restart, showing its progress as a banner under the toolbar.
 */
export class ForkUpdateBanner extends React.Component<
  IForkUpdateBannerProps,
  IForkUpdateBannerState
> {
  private unmounted = false
  private upToDateTimer: number | null = null

  public constructor(props: IForkUpdateBannerProps) {
    super(props)
    this.state = {
      status: 'idle',
      update: null,
      method: 'manual',
      current: '',
      progress: 0,
      error: null,
      dismissedVersion: null,
    }
  }

  public componentDidMount() {
    on('fork-update-progress', this.onProgress)
    window.addEventListener(CheckForUpdatesNowEvent, this.onCheckNow)
  }

  public componentWillUnmount() {
    this.unmounted = true
    removeListener('fork-update-progress', this.onProgress)
    window.removeEventListener(CheckForUpdatesNowEvent, this.onCheckNow)
    if (this.upToDateTimer !== null) {
      window.clearTimeout(this.upToDateTimer)
    }
  }

  private onProgress = (_: IpcRendererEvent, fraction: number) => {
    this.setState({ progress: fraction })
  }

  private onCheckNow = () => {
    this.check(false)
  }

  /**
   * Looks for a new version. In the background, errors and "up to date" are
   * silent.
   */
  public async check(inBackground: boolean) {
    const { status } = this.state
    if (
      status === 'checking' ||
      status === 'downloading' ||
      status === 'installing' ||
      status === 'ready'
    ) {
      return
    }

    this.setState({ status: inBackground ? status : 'checking', error: null })
    const result = await invoke('fork-update-check')
    if (this.unmounted) {
      return
    }

    switch (result.kind) {
      case 'error':
        log.warn(`Fork updater: ${result.message}`)
        this.setState({
          status: inBackground ? 'idle' : 'error',
          error: result.message,
        })
        return
      case 'up-to-date':
        if (inBackground) {
          this.setState({ status: 'idle' })
        } else {
          this.setState({ status: 'up-to-date', current: result.current })
          this.upToDateTimer = window.setTimeout(
            () => this.setState({ status: 'idle' }),
            6000
          )
        }
        return
      case 'available':
        this.setState({
          status: 'available',
          update: result.update,
          method: result.method,
          current: result.current,
          dismissedVersion: inBackground ? this.state.dismissedVersion : null,
        })
        if (getForkUpdateMode() === 'auto' && result.method !== 'manual') {
          this.download()
        }
        return
    }
  }

  private download = async () => {
    this.setState({ status: 'downloading', progress: 0, error: null })
    const result = await invoke('fork-update-download')
    if (this.unmounted) {
      return
    }
    if (result.kind === 'error') {
      this.setState({ status: 'error', error: result.message })
    } else {
      this.setState({ status: 'ready' })
    }
  }

  private install = async () => {
    this.setState({ status: 'installing', error: null })
    const result = await invoke('fork-update-install')
    // On success the app restarts; we only get here on errors.
    if (!this.unmounted && result.kind === 'error') {
      this.setState({ status: 'error', error: result.message })
    }
  }

  private onWhatsNew = () => {
    if (this.state.update !== null) {
      this.props.onOpenUrl(this.state.update.htmlUrl)
    }
  }

  private onOpenReleases = () => {
    this.props.onOpenUrl(
      this.state.update?.htmlUrl ??
        `https://github.com/${__UPDATE_REPOSITORY__}/releases`
    )
  }

  private onDismissed = () => {
    const { status, update } = this.state
    if (status === 'error' || status === 'up-to-date') {
      this.setState({ status: update !== null ? 'available' : 'idle' })
    }
    this.setState({ dismissedVersion: update?.version ?? null })
  }

  private renderContents() {
    const { status, update, method, progress, error, current } = this.state
    const version = update?.version ?? ''

    switch (status) {
      case 'checking':
        return (
          <>
            <Loading /> Looking for a new version…
          </>
        )
      case 'up-to-date':
        return (
          <>
            <Octicon symbol={octicons.checkCircleFill} className="ok" />
            You're on the latest version ({current}).
          </>
        )
      case 'available':
        return (
          <>
            <Octicon symbol={octicons.sparkleFill} className="accent" />
            <span>
              Version <strong>{version}</strong> is available.{' '}
              <LinkButton onClick={this.onWhatsNew}>What's new</LinkButton>
              {' · '}
              {method === 'manual' ? (
                <LinkButton onClick={this.onOpenReleases}>
                  Download it
                </LinkButton>
              ) : (
                <LinkButton onClick={this.download}>Update now</LinkButton>
              )}
            </span>
          </>
        )
      case 'downloading':
        return (
          <>
            <Loading />
            <span>
              Downloading version <strong>{version}</strong>…{' '}
              {Math.round(progress * 100)}%
            </span>
            <span className="fork-update-progress">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </span>
          </>
        )
      case 'ready':
        return (
          <>
            <Octicon symbol={octicons.download} className="accent" />
            <span>
              Version <strong>{version}</strong> is ready.{' '}
              <LinkButton onClick={this.onWhatsNew}>What's new</LinkButton>
              {' · '}
              <LinkButton onClick={this.install}>
                {methodNeedsPassword(method)
                  ? 'Install & restart (asks for your password)'
                  : 'Restart to update'}
              </LinkButton>
            </span>
          </>
        )
      case 'installing':
        return (
          <>
            <Loading />
            {methodNeedsPassword(method)
              ? 'Installing… enter your password in the system window.'
              : 'Installing and restarting…'}
          </>
        )
      case 'error':
        return (
          <>
            <Octicon symbol={octicons.alert} className="warn" />
            <span>
              {error ?? 'The update failed.'}{' '}
              <LinkButton onClick={this.onOpenReleases}>
                Open the release page
              </LinkButton>
            </span>
          </>
        )
      case 'idle':
        return null
    }
  }

  public render() {
    const { status, update, dismissedVersion } = this.state
    if (status === 'idle') {
      return null
    }
    if (
      (status === 'available' || status === 'ready') &&
      update !== null &&
      dismissedVersion === update.version
    ) {
      return null
    }

    return (
      <Banner
        id="fork-update-banner"
        className="fork-update-banner"
        dismissable={status !== 'installing' && status !== 'downloading'}
        onDismissed={this.onDismissed}
      >
        {this.renderContents()}
      </Banner>
    )
  }
}
