import { Component, type ReactNode } from "react";

/** Last line of defence: a render error shows what broke and a reload button, instead of a blank window. */
export class CrashGuard extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-title">Happy hit an error drawing this screen.</div>
        <div className="crash-msg">{e.message}</div>
        <div className="crash-acts">
          <button className="kb pri" onClick={() => location.reload()}>
            reload
          </button>
          <button className="kb" onClick={() => void navigator.clipboard.writeText(`${e.message}\n${e.stack ?? ""}`)}>
            copy details
          </button>
        </div>
        <pre className="crash-raw">{e.stack}</pre>
      </div>
    );
  }
}
