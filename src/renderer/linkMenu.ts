import { hub } from "./App";
import { useMenu } from "./Menu";
import { usePane } from "./pane";

const isRemote = () => !!(window as { hub?: { isRemote?: boolean } }).hub?.isRemote;

/** Right-click on a web link in a chat: open in Chrome (the default click), open inside Happy, or copy. */
export function useLinkMenu() {
  const menu = useMenu();
  const pane = usePane();
  return (e: React.MouseEvent, url: string) => {
    if (isRemote() || !/^https?:\/\//i.test(url)) return;
    menu.atMouse(e, [
      { label: "Open in Chrome", onSelect: () => void hub().openInChrome(url) },
      ...(pane.openInHappy ? [{ label: "Open in Happy", onSelect: () => pane.openInHappy!(url) }] : []),
      { type: "separator" as const },
      { label: "Copy link", onSelect: () => void navigator.clipboard.writeText(url) },
    ]);
  };
}
