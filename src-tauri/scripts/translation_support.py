#!/usr/bin/env python3
import argparse
import json
import re
import sys


SKIP_TAGS = {
    "code",
    "kbd",
    "math",
    "noscript",
    "pre",
    "script",
    "style",
    "textarea",
}

MATH_PATTERN = re.compile(r"(\${1,3}.*?\${1,3})", re.DOTALL)
MATHISH_CHARS = set("$\\{}_^=<>|")
SKIP_CLASS_NAMES = {
    "header",
    "title",
    "time-limit",
    "memory-limit",
    "input-file",
    "output-file",
}


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def load_argos():
    try:
        import argostranslate.package
        import argostranslate.translate
    except ImportError as exc:
        fail(
            "Argos Translate runtime is unavailable. Please install local translation support first. "
            f"({exc})"
        )

    return argostranslate.package, argostranslate.translate


def should_skip_for_class(node) -> bool:
    current = node.parent
    while current is not None:
        classes = current.get("class", []) if hasattr(current, "get") else []
        if any(class_name in SKIP_CLASS_NAMES for class_name in classes):
            return True
        current = current.parent
    return False


def has_natural_language(text: str) -> bool:
    return any(ch.isalpha() for ch in text)


def looks_formula_heavy(text: str) -> bool:
    alpha_count = sum(ch.isalpha() for ch in text)
    mathish_count = sum(ch in MATHISH_CHARS for ch in text)
    return mathish_count > alpha_count


def split_preserving_math(text: str) -> list[str]:
    if not text:
        return [text]

    parts: list[str] = []
    last_index = 0
    for match in MATH_PATTERN.finditer(text):
        start, end = match.span()
        if start > last_index:
            parts.append(text[last_index:start])
        parts.append(match.group(0))
        last_index = end

    if last_index < len(text):
        parts.append(text[last_index:])

    return parts or [text]


def translate_text_preserving_math(translator, text: str, cache: dict[str, str]) -> str:
    segments = split_preserving_math(text)
    translated_segments: list[str] = []

    for segment in segments:
        if not segment:
            continue
        if MATH_PATTERN.fullmatch(segment):
            translated_segments.append(segment)
            continue
        if not segment.strip() or not has_natural_language(segment) or looks_formula_heavy(segment):
            translated_segments.append(segment)
            continue

        translated = cache.get(segment)
        if translated is None:
            translated = translator.translate(segment)
            cache[segment] = translated
        translated_segments.append(translated)

    return "".join(translated_segments)


def find_translator(from_code: str, to_code: str):
    _, translate = load_argos()
    languages = translate.get_installed_languages()
    from_lang = next((lang for lang in languages if lang.code == from_code), None)
    to_lang = next((lang for lang in languages if lang.code == to_code), None)
    if from_lang is None or to_lang is None:
        return None
    return from_lang.get_translation(to_lang)


def cmd_status(args: argparse.Namespace) -> None:
    translator = find_translator(args.from_lang, args.to_lang)
    if translator is None:
        print(
            json.dumps(
                {
                    "ready": False,
                    "message": "Chinese statement support is not installed yet.",
                }
            )
        )
        return

    print(json.dumps({"ready": True, "message": "Chinese statement support is ready."}))


def cmd_install(args: argparse.Namespace) -> None:
    package, _ = load_argos()
    if find_translator(args.from_lang, args.to_lang) is not None:
        print(json.dumps({"ready": True, "message": "Chinese statement support is ready."}))
        return

    log("Updating Argos package index...")
    package.update_package_index()
    log("Looking for an English -> Chinese package...")
    available_packages = package.get_available_packages()
    matched_package = next(
        (
            item
            for item in available_packages
            if item.from_code == args.from_lang and item.to_code == args.to_lang
        ),
        None,
    )

    if matched_package is None:
        fail(
            f"No Argos language package is available for {args.from_lang} -> {args.to_lang}."
        )

    log("Downloading translation package...")
    download_path = matched_package.download()
    log("Installing translation package...")
    package.install_from_path(download_path)

    if find_translator(args.from_lang, args.to_lang) is None:
        fail("Argos language package installation finished, but the translator is still unavailable.")

    log("Translation package installed.")
    print(json.dumps({"ready": True, "message": "Chinese statement support is ready."}))


def cmd_translate(args: argparse.Namespace) -> None:
    translator = find_translator(args.from_lang, args.to_lang)
    if translator is None:
        fail("Chinese statement support is not installed yet.")

    try:
        from bs4 import BeautifulSoup, NavigableString
    except ImportError as exc:
        fail(f"BeautifulSoup is required for local translation: {exc}")

    html = sys.stdin.read()
    if not html.strip():
        fail("No HTML content was received for translation.")

    def should_translate(node: NavigableString) -> bool:
        if not node.strip():
            return False

        parent = node.parent
        if parent is None:
            return False
        if parent.name in SKIP_TAGS:
            return False
        if parent.has_attr("class") and "MathJax" in parent.get("class", []):
            return False
        if should_skip_for_class(node):
            return False
        return True

    soup = BeautifulSoup(html, "html.parser")
    cache: dict[str, str] = {}

    for node in soup.find_all(string=True):
        if not isinstance(node, NavigableString) or not should_translate(node):
            continue

        original = str(node)
        translated = translate_text_preserving_math(translator, original, cache)
        node.replace_with(translated)

    sys.stdout.write(str(soup))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_lang_args(target: argparse.ArgumentParser) -> None:
        target.add_argument("--from-lang", default="en")
        target.add_argument("--to-lang", default="zh")

    status_parser = subparsers.add_parser("status")
    add_lang_args(status_parser)
    status_parser.set_defaults(func=cmd_status)

    install_parser = subparsers.add_parser("install")
    add_lang_args(install_parser)
    install_parser.set_defaults(func=cmd_install)

    translate_parser = subparsers.add_parser("translate")
    add_lang_args(translate_parser)
    translate_parser.set_defaults(func=cmd_translate)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
