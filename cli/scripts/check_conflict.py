"""Conflict classification checks. Does not touch a Cursor database."""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cursor_saves.paths import local_path_from_file_uri, project_identifier_from  # noqa: E402
from cursor_saves.importer import (  # noqa: E402
    build_merge_write_plan,
    classify_bubble_sets,
    is_recent,
    remote_allowed,
)


def main() -> None:
    local = {"b1", "b2"}
    incoming = {"b1", "b3"}
    assert len(local) == len(incoming)
    got = classify_bubble_sets(local, incoming)
    assert got == "diverged", got

    assert classify_bubble_sets({"b1", "b2"}, {"b1", "b2"}) == "identical"
    assert classify_bubble_sets(None, {"b1"}) == "new"
    assert classify_bubble_sets({"b1", "b2"}, {"b1"}) == "local_ahead"
    assert classify_bubble_sets({"b1"}, {"b1", "b2"}) == "incoming_newer"
    assert classify_bubble_sets(set(), set()) == "identical"

    plan = build_merge_write_plan(
        [{"bubbleId": "a", "text": "local-a"}, {"bubbleId": "b", "text": "local-b"}],
        [{"bubbleId": "b", "text": "remote-b"}, {"bubbleId": "c", "text": "remote-c"}],
        {"a", "b"},
        {
            "a": {"text": "remote-a"},
            "b": {"text": "remote-b"},
            "c": {"text": "only-remote"},
        },
    )
    assert [header["bubbleId"] for header in plan["headers"]] == ["a", "b", "c"]
    assert set(plan["bubbles"]) == {"c"}
    assert plan["bubbles"]["c"]["text"] == "only-remote"
    assert "a" not in plan["bubbles"] and "b" not in plan["bubbles"]
    assert plan["checkpoints"] == {}
    assert plan["agentBlobs"] == {}

    assert local_path_from_file_uri("file:///work/QQchat_%E5%89%AF%E6%9C%AC") == "/work/QQchat_副本"
    app = project_identifier_from("git@github.com:me/repo.git", "/work/app")
    other = project_identifier_from("https://github.com/me/repo.git", "/work/app-copy")
    assert app == "github.com-me-repo--app"
    assert other == "github.com-me-repo--app-copy"
    assert app != other
    assert remote_allowed("github.com-me-repo--app", ["github.com-me-repo--app"], [])
    assert not remote_allowed("github.com-me-repo--app", ["github.com-me-repo--other"], [])
    assert not remote_allowed("github.com-me-repo--app", ["git@github.com:me/repo.git"], [])
    assert not remote_allowed("github.com-me-repo--app", [], ["github.com-me-repo--app"])

    now = datetime(2026, 1, 10, tzinfo=timezone.utc)
    recent = (now - timedelta(days=2)).isoformat()
    stale = (now - timedelta(days=40)).isoformat()
    assert is_recent(recent, None, 7, now=now)
    assert not is_recent(stale, None, 7, now=now)
    assert is_recent(stale, int(now.timestamp() * 1000), 7, now=now)
    assert is_recent(None, None, 7, now=now)

    print("ok")


if __name__ == "__main__":
    main()
