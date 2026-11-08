#!/usr/bin/env python3
import argparse
import functools
import heapq
import itertools
import json
import math
import queue
import random
import re
import sys
import threading
import time
import traceback
import webbrowser
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_MODEL = "Qwen/Qwen3.5-2B"
WEB_DIR = Path(__file__).resolve().parent / "web"
THINK_TOKENS = 150

# (Name, dx, dy, Buchstabe)
DIRS = [("up", 0, -1, "U"), ("right", 1, 0, "R"), ("down", 0, 1, "D"), ("left", -1, 0, "L")]

STEP_SYSTEM = ("You are a robot in a grid maze. x grows to the right, y grows downwards. "
               "You cannot see the whole maze, only your direct neighbours. "
               "Reach the goal. Answer with the number of ONE option only.")

ONESHOT_SYSTEM = ("You solve grid mazes. '#' is a wall, '.' is free, S is start, G is goal. "
                  "Moves: U (up), D (down), L (left), R (right). No diagonal moves. "
                  "Output ONLY the moves separated by spaces, nothing else.")


# --------------------------------------------------------------------------- #
#  Laufsteuerung: Pause, Abbruch, Tempo
# --------------------------------------------------------------------------- #
class Cancelled(Exception):
    """Der Lauf wurde abgebrochen."""


class RunControl:
    """Zustand eines Laufs, den der Browser über /llm/control ändern kann."""

    def __init__(self, delay_ms=0):
        self.cancelled = threading.Event()
        self.running = threading.Event()   # nicht gesetzt = pausiert
        self.running.set()
        self.delay = delay_ms / 1000
        self.ping = None                   # sendet während der Pause ein Lebenszeichen

    def cancel(self):
        self.cancelled.set()
        self.running.set()

    def wait_if_paused(self):
        """Blockiert, solange pausiert ist. Wirft Cancelled bei Abbruch."""
        last_ping = time.monotonic()
        while not self.running.wait(0.25):
            if self.ping and time.monotonic() - last_ping > 2:
                self.ping()
                last_ping = time.monotonic()
        if self.cancelled.is_set():
            raise Cancelled()

    def sleep(self, seconds):
        """Wartet `seconds` Sekunden, reagiert dabei auf Pause und Abbruch."""
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.wait_if_paused()
            if self.cancelled.wait(max(0, min(end - time.monotonic(), 0.05))):
                raise Cancelled()


RUNS = {}                 # run_id -> RunControl
RUNS_LOCK = threading.Lock()


# --------------------------------------------------------------------------- #
#  Modell
# --------------------------------------------------------------------------- #
class LLM:
    """Echtes Sprachmodell über Hugging Face transformers."""

    def __init__(self, model_id):
        import torch
        from transformers import AutoTokenizer
        self.torch = torch
        if torch.cuda.is_available():
            self.device, dtype = "cuda", torch.bfloat16
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            self.device, dtype = "mps", torch.float16
        else:
            self.device, dtype = "cpu", torch.float32
        print(f"Lade {model_id} auf {self.device} …")
        self.tok = AutoTokenizer.from_pretrained(model_id)
        try:
            from transformers import AutoModelForCausalLM
            self.model = AutoModelForCausalLM.from_pretrained(model_id, dtype=dtype)
        except (ValueError, KeyError):   # manche Qwen-Modelle sind multimodal
            from transformers import AutoModelForImageTextToText
            self.model = AutoModelForImageTextToText.from_pretrained(model_id, dtype=dtype)
        self.model.to(self.device).eval()
        self.digit_ids = [self.tok.encode(str(i), add_special_tokens=False)[0] for i in range(1, 10)]
        self.think_end_id = self.tok.convert_tokens_to_ids("</think>")
        self.lock = threading.Lock()
        print("Modell bereit.")

    def _prompt(self, system, user, thinking=False):
        """Baut den Chat-Text für das Modell. Gibt einen String zurück."""
        msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        try:
            text = self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True,
                                                enable_thinking=thinking)
        except TypeError:
            text = self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        if thinking and not text.rstrip().endswith("<think>"):
            text += "<think>\n"
        return text

    def choose(self, system, user, n_options, temperature, thought=None):
        """Lässt das Modell eine Option 1..n wählen, ohne Text zu erzeugen:
        wir lesen nur die Wahrscheinlichkeiten der Ziffern-Tokens ab.
        `thought`: optionaler Thinking-Text vor der Antwort.
        Gibt (gewählter Index, Liste der Wahrscheinlichkeiten) zurück."""
        torch = self.torch
        if thought is None:
            text = self._prompt(system, user)
        else:
            text = self._prompt(system, user, thinking=True) + thought.strip() + "\n</think>\n\n"
        ids = self.tok(text, return_tensors="pt").to(self.device)
        with self.lock, torch.no_grad():
            logits = self.model(**ids).logits[0, -1].float()
        logits = logits[self.digit_ids[:n_options]]
        probs = torch.softmax(logits, dim=-1)
        if temperature <= 0:
            idx = int(torch.argmax(logits))
        else:
            idx = int(torch.multinomial(torch.softmax(logits / temperature, dim=-1), 1))
        return idx, probs.tolist()

    def stream(self, system, user, temperature, max_new_tokens, ctl, thinking=False):
        """Erzeugt Text und liefert ihn Stück für Stück (Generator von Strings).
        thinking=True: erzeugt nur den Denk-Teil und stoppt bei </think>."""
        torch = self.torch
        from transformers import StoppingCriteria, StoppingCriteriaList, TextIteratorStreamer
        ids = self.tok(self._prompt(system, user, thinking), return_tensors="pt").to(self.device)
        streamer = TextIteratorStreamer(self.tok, skip_prompt=True, skip_special_tokens=True, timeout=0.5)
        think_end = self.think_end_id if thinking else None

        class StopOrPause(StoppingCriteria):
            def __call__(self, input_ids, scores, **kw):
                while not ctl.running.wait(0.25):   # Pause hält das Modell an
                    pass
                stop = ctl.cancelled.is_set() or int(input_ids[0, -1]) == think_end
                return torch.full((input_ids.shape[0],), stop, dtype=torch.bool, device=input_ids.device)

        settings = dict(max_new_tokens=max_new_tokens, pad_token_id=self.tok.eos_token_id,
                        streamer=streamer, stopping_criteria=StoppingCriteriaList([StopOrPause()]))
        if temperature > 0:
            settings.update(do_sample=True, temperature=temperature)
        else:
            settings.update(do_sample=False)
        errors = []

        def generate():
            try:
                with self.lock, torch.no_grad():
                    self.model.generate(**ids, **settings)
            except Exception as e:
                errors.append(e)
                streamer.end()

        worker = threading.Thread(target=generate, daemon=True)
        worker.start()
        chunks = iter(streamer)
        while True:
            try:
                chunk = next(chunks)
            except StopIteration:
                break
            except queue.Empty:   # noch kein neuer Text, z. B. wegen Pause
                if not ctl.running.is_set() and ctl.ping:
                    ctl.ping()
                continue
            yield chunk.replace("</think>", "")
        worker.join(timeout=5)
        if errors:
            raise errors[0]
        if ctl.cancelled.is_set():
            raise Cancelled()


class MockLLM:
    """Ersatz ohne Modell zum Testen der Oberfläche. Kein echtes LLM!"""

    @staticmethod
    def _scores(user):
        """Bewertet die Optionen im Prompt nach Abstand zum Ziel. Gibt [(Name, Punkte)] zurück."""
        gx, gy = map(int, re.search(r"Goal: \((\d+), (\d+)\)", user).groups())
        scores = []
        for name, x, y, rest in re.findall(r"^\d: (\w+) -> \((\d+), (\d+)\)(.*)$", user, re.M):
            visited = re.search(r"visited (\d+)", rest)
            penalty = 3 * int(visited.group(1)) if visited else 0
            scores.append((name, -(abs(gx - int(x)) + abs(gy - int(y))) - penalty))
        return scores

    def choose(self, system, user, n_options, temperature, thought=None):
        scores = [s for _, s in self._scores(user)]
        weights = [math.exp(0.8 * (s - max(scores))) for s in scores]
        probs = [wt / sum(weights) for wt in weights]
        if temperature <= 0:
            idx = scores.index(max(scores))
        else:
            idx = random.choices(range(n_options), weights=[p ** (1 / temperature) for p in probs])[0]
        return idx, probs

    def stream(self, system, user, temperature, max_new_tokens, ctl, thinking=False):
        if thinking:
            scores = self._scores(user)
            best = max(range(len(scores)), key=lambda i: scores[i][1])
            goal = user.split("The goal is ")[1].split(" from")[0]
            text = (f"(Mock) The goal is {goal}. Going {scores[best][0]} brings me closer, "
                    f"so option {best + 1} looks best.")
        else:   # Luftlinie, ignoriert Wände wie ein "halluzinierter" Weg
            rows = [line for line in user.splitlines() if line and set(line) <= set(".#SG")]
            (sx, sy), (gx, gy) = [(row.index(c), y) for c in "SG" for y, row in enumerate(rows) if c in row]
            moves = ["R" if gx > sx else "L"] * abs(gx - sx) + ["D" if gy > sy else "U"] * abs(gy - sy)
            text = " ".join(moves)
        for word in re.findall(r"\S+\s*", text):
            ctl.wait_if_paused()
            if ctl.cancelled.wait(0.03):
                raise Cancelled()
            yield word


# --------------------------------------------------------------------------- #
#  Hilfsfunktionen
# --------------------------------------------------------------------------- #
def look_around(walls, pos):
    """Gibt (freie Nachbarn als [(Richtung, Feld)], blockierte Richtungen) zurück."""
    h, w = len(walls), len(walls[0])
    free, blocked = [], []
    for name, dx, dy, _ in DIRS:
        x, y = pos[0] + dx, pos[1] + dy
        if 0 <= x < w and 0 <= y < h and not walls[y][x]:
            free.append((name, (x, y)))
        else:
            blocked.append(name)
    return free, blocked


def mark_opened(options, seen):
    """Merkt neue Felder in `seen`. Gibt die "opened"-Operationen für den Browser zurück."""
    ops = []
    for _, cell in options:
        if cell not in seen:
            seen.add(cell)
            ops.append({"x": cell[0], "y": cell[1], "attr": "opened", "value": True})
    return ops


def closed_op(cell):
    """Operation, die ein Feld im Browser als besucht (blau) markiert."""
    return {"x": cell[0], "y": cell[1], "attr": "closed", "value": True}


def shortest_path_len(walls, start, end):
    """Breitensuche. Gibt die Länge des kürzesten Wegs zurück, oder None."""
    todo, seen = deque([(start, 0)]), {start}
    while todo:
        pos, dist = todo.popleft()
        if pos == end:
            return dist
        for _, cell in look_around(walls, pos)[0]:
            if cell not in seen:
                seen.add(cell)
                todo.append((cell, dist + 1))
    return None


def local_map(walls, pos, end, radius, visited=()):
    """Ausschnitt der Karte um `pos` mit (2*radius+1)² Feldern, wie ein Faltungs-Kern.
    Gibt die Zeilen als Text zurück: X du, G Ziel, # Wand/Rand, + besucht, . frei."""
    h, w = len(walls), len(walls[0])
    rows = []
    for y in range(pos[1] - radius, pos[1] + radius + 1):
        row = []
        for x in range(pos[0] - radius, pos[0] + radius + 1):
            if (x, y) == pos:
                row.append("X")
            elif (x, y) == end:
                row.append("G")
            elif not (0 <= x < w and 0 <= y < h) or walls[y][x]:
                row.append("#")
            elif (x, y) in visited:
                row.append("+")
            else:
                row.append(".")
        rows.append(" ".join(row))
    return "\n".join(rows)


def make_prompt(pos, end, options, blocked, explored=(), visits=None, thinking=False, view_map=None):
    """Baut den Prompt für einen Schritt. `visits`: {Feld: Anzahl} oder None,
    `view_map`: Text von local_map() oder None. Gibt einen String zurück."""
    (x, y), (gx, gy) = pos, end
    lines = [f"Position: ({x}, {y})",
             f"Goal: ({gx}, {gy})",
             f"The goal is {abs(gx - x)} {'right' if gx >= x else 'left'} and "
             f"{abs(gy - y)} {'down' if gy >= y else 'up'} from you."]
    if view_map:
        size = view_map.count("\n") + 1
        lines += [f"Your view ({size}x{size}, up is north). X = you, G = goal, "
                  "# = wall or outside, + = already visited, . = free:", view_map]
    if blocked:
        lines.append("Blocked: " + ", ".join(blocked))
    if explored:
        lines.append("Already explored: " + ", ".join(explored))
    lines.append("Options:")
    for i, (name, cell) in enumerate(options, 1):
        extra = f" [visited {visits[cell]}x]" if visits and visits.get(cell) else ""
        lines.append(f"{i}: {name} -> ({cell[0]}, {cell[1]}){extra}")
    if thinking:
        lines.append("Think briefly (at most 2 short sentences), then answer with one number.")
    else:
        lines.append("Answer with one number.")
    return "\n".join(lines)


def ask_llm(llm, user, n_options, temperature, ctl, n, thinking):
    """Fragt das LLM nach einer Option und liefert dabei "think"-Events (Generator).
    Gibt (Index, Wahrscheinlichkeiten, Thinking-Text oder None) zurück."""
    thought = None
    if thinking:
        thought = ""
        for chunk in llm.stream(STEP_SYSTEM, user, temperature, THINK_TOKENS, ctl, thinking=True):
            thought += chunk
            yield {"type": "think", "n": n, "text": chunk}
    idx, probs = llm.choose(STEP_SYSTEM, user, n_options, temperature, thought=thought)
    return idx, probs, thought


def step_event(n, pos, options, probs, chosen, user, ops, visits=None, **extra):
    """Event für einen Schritt: was das LLM sah, wie es bewertete und was es wählte."""
    return {
        "type": "step", "n": n, "pos": list(pos),
        "options": [{"dir": name, "to": list(cell), "p": probs[i],
                     "visited": (visits or {}).get(cell, 0)}
                    for i, (name, cell) in enumerate(options)],
        "chosen": chosen, "to": list(options[chosen][1]),
        "prompt": user and f"SYSTEM:\n{STEP_SYSTEM}\n\nUSER:\n{user}",
        "ops": ops, **extra,
    }


def path_to(parent, end):
    """Folgt den Vorgängern vom Ziel zum Start. Gibt den Weg als [[x, y], …] zurück."""
    path, cell = [], end
    while cell is not None:
        path.append(list(cell))
        cell = parent[cell]
    return path[::-1]


def view_text(view):
    """Gibt z. B. ", Sicht 5×5" zurück, oder "" für nur 4 Nachbarn."""
    return f", Sicht {2 * view + 1}×{2 * view + 1}" if view else ""


def optimal_text(walls, start, end):
    """Gibt die optimale Weglänge als Text zurück."""
    optimal = shortest_path_len(walls, start, end)
    return "kein Weg" if optimal is None else str(optimal)


# --------------------------------------------------------------------------- #
#  Modi: Generatoren, die Events liefern, zuletzt ein "done"-Event
# --------------------------------------------------------------------------- #
def run_step(llm, walls, start, end, memory, temperature, max_steps, ctl, thinking=False, view=0):
    """Das LLM läuft Schritt für Schritt und sieht seine Nachbarfelder.
    memory=True: der Prompt zeigt, wie oft ein Feld schon besucht wurde.
    view > 0: zusätzlich ein Kartenausschnitt mit Radius `view`."""
    pos, path = start, [list(start)]
    visits = {start: 1}
    seen = {start}
    confidences = []
    for n in range(1, max_steps + 1):
        if pos == end:
            break
        ctl.wait_if_paused()
        options, blocked = look_around(walls, pos)
        if not options:
            break
        ops = mark_opened(options, seen)
        shown_visits = dict(visits) if memory else None
        view_map = local_map(walls, pos, end, view, visits if memory else ()) if view else None
        user = make_prompt(pos, end, options, blocked, visits=shown_visits, thinking=thinking,
                           view_map=view_map)
        idx, probs, thought = yield from ask_llm(llm, user, len(options), temperature, ctl, n, thinking)
        confidences.append(probs[idx])

        old, pos = pos, options[idx][1]
        visits[pos] = visits.get(pos, 0) + 1
        path.append(list(pos))
        ops.append(closed_op(pos))
        yield step_event(n, old, options, probs, idx, user, ops, shown_visits, thought=thought)
        if pos != end and ctl.delay:
            ctl.sleep(ctl.delay)

    steps = len(path) - 1
    yield {"type": "done", "operations": [], "path": path, "stats": {"lines": [
        "Modus: Schritt für Schritt" + (" + Thinking" if thinking else "") + view_text(view),
        f"Ziel erreicht: {'ja' if pos == end else 'NEIN'}",
        f"Schritte: {steps}  (optimal: {optimal_text(walls, start, end)})",
        f"Felder angesehen: {len(seen) - 1}",
        f"Felder doppelt betreten: {steps + 1 - len(visits)}",
        f"Unsichere Züge (&lt;60%): {sum(p < 0.6 for p in confidences)}/{len(confidences)}",
    ]}}


def run_bestfirst(llm, walls, start, end, max_steps, ctl, thinking=False, view=0):
    """Best-First-Suche mit dem LLM als Heuristik: das LLM bewertet die Nachbarn
    eines Felds, erkundet wird immer die offene Option mit der höchsten
    Wahrscheinlichkeit, auch wenn sie woanders liegt (Rücksprung).
    `max_steps` begrenzt die Zahl der LLM-Aufrufe, `view` ist der Sichtradius."""
    order = itertools.count()
    frontier = [(-1.0, 0, start, None, None)]   # (-Wahrscheinlichkeit, -Reihenfolge, Feld, Vorgänger, Richtung)
    parent, seen = {}, {start}
    calls = forced = jumps = n = 0
    confidences, last, reached = [], None, False

    while frontier and calls < max_steps:
        neg_p, _, cell, came_from, direction = heapq.heappop(frontier)
        if cell in parent:
            continue
        ctl.wait_if_paused()
        parent[cell] = came_from
        n += 1
        if came_from is not None and came_from != last:
            jumps += 1
            yield {"type": "jump", "n": n, "to": list(cell), "via": list(came_from),
                   "dir": direction, "p": -neg_p}
            n += 1
        last = cell
        ops = [] if cell == start else [closed_op(cell)]
        if cell == end:
            reached = True
            yield {"type": "visit", "n": n, "at": list(cell), "ops": ops}
            break

        free, blocked = look_around(walls, cell)
        explored = [name for name, c in free if c in parent]
        options = [(name, c) for name, c in free if c not in parent]
        ops += mark_opened(options, seen)
        if not options:
            yield {"type": "deadend", "n": n, "at": list(cell), "ops": ops}
            continue

        if len(options) == 1:   # keine Wahl, also kein LLM-Aufruf
            probs, thought, user = [1.0], None, None
            forced += 1
        else:
            view_map = local_map(walls, cell, end, view, parent) if view else None
            user = make_prompt(cell, end, options, blocked, explored, thinking=thinking, view_map=view_map)
            _, probs, thought = yield from ask_llm(llm, user, len(options), 0, ctl, n, thinking)
            calls += 1
            confidences.append(max(probs))
        for (name, c), p in zip(options, probs):
            heapq.heappush(frontier, (-p, -next(order), c, cell, name))
        best = probs.index(max(probs))
        yield step_event(n, cell, options, probs, best, user, ops,
                         at=list(cell), forced=len(options) == 1, thought=thought)
        if ctl.delay:
            ctl.sleep(ctl.delay)

    path = path_to(parent, end) if reached else []
    limit_hit = "  – Limit erreicht" if calls >= max_steps and not reached else ""
    yield {"type": "done", "operations": [], "path": path, "stats": {"lines": [
        "Modus: LLM-Best-First" + (" + Thinking" if thinking else "") + view_text(view),
        f"Ziel erreicht: {'ja' if reached else 'NEIN'}",
        f"Weglänge: {max(len(path) - 1, 0)}  (optimal: {optimal_text(walls, start, end)})",
        f"Felder erkundet: {len(parent)}",
        f"LLM-Aufrufe: {calls}  (+{forced} Felder ohne Wahl){limit_hit}",
        f"Rücksprünge: {jumps}",
        f"Unsichere Bewertungen (&lt;60%): {sum(p < 0.6 for p in confidences)}/{len(confidences)}",
    ]}}


def maze_to_text(walls, start, end):
    """Gibt die Karte als Text zurück: '#' Wand, '.' frei, S Start, G Ziel."""
    rows = []
    for y, row in enumerate(walls):
        rows.append("".join("S" if (x, y) == start else "G" if (x, y) == end else "#" if wall else "."
                            for x, wall in enumerate(row)))
    return "\n".join(rows)


def parse_moves(text):
    """Liest Züge aus der LLM-Antwort ("R R D", "RRD", "right, down"). Gibt z. B. ['R', 'R', 'D'] zurück."""
    moves = []
    for token in re.findall(r"\b(?:[Uu]p|[Dd]own|[Ll]eft|[Rr]ight|UP|DOWN|LEFT|RIGHT|[UDLR]+|[udlr])\b", text):
        if token.lower() in ("up", "down", "left", "right"):
            moves.append(token[0].upper())
        else:
            moves += list(token.upper())
    return moves


def check_moves(walls, start, end, moves):
    """Läuft die Züge ab. Gibt (Weg, Operationen, Fehlertext oder None) zurück."""
    h, w = len(walls), len(walls[0])
    delta = {letter: (dx, dy) for _, dx, dy, letter in DIRS}
    pos, path, ops = start, [list(start)], []
    for i, move in enumerate(moves, 1):
        x, y = pos[0] + delta[move][0], pos[1] + delta[move][1]
        if not (0 <= x < w and 0 <= y < h):
            return path, ops, f"Zug {i} ({move}) geht aus der Karte"
        if walls[y][x]:
            ops.append({"x": x, "y": y, "attr": "opened", "value": True})
            return path, ops, f"Zug {i} ({move}) geht durch eine Wand bei ({x}, {y})"
        pos = (x, y)
        path.append([x, y])
        ops.append(closed_op(pos))
        if pos == end:
            break
    return path, ops, None


def run_oneshot(llm, walls, start, end, temperature, max_steps, ctl):
    """Das LLM bekommt die ganze Karte und schreibt alle Züge auf einmal.
    Streamt den Text ("token"-Events) und prüft die Züge danach."""
    user = "Maze:\n" + maze_to_text(walls, start, end) + "\n\nMoves from S to G:"
    yield {"type": "prompt", "prompt": f"SYSTEM:\n{ONESHOT_SYSTEM}\n\nUSER:\n{user}"}
    answer = ""
    for chunk in llm.stream(ONESHOT_SYSTEM, user, temperature, min(4 * max_steps, 1500), ctl):
        answer += chunk
        yield {"type": "token", "text": chunk}
    print("One-Shot Antwort:", answer)

    moves = parse_moves(answer)
    path, ops, error = check_moves(walls, start, end, moves)
    reached = error is None and path[-1] == list(end)
    preview = " ".join(moves[:40]) + (" …" if len(moves) > 40 else "")
    yield {"type": "done", "operations": ops, "path": path, "stats": {"lines": [
        "Modus: One-Shot",
        f"Ziel erreicht: {'ja' if reached else 'NEIN'}",
        f"Züge vom LLM: {len(moves)}  (optimal: {optimal_text(walls, start, end)})",
        f"Fehler: {error or ('Weg endet vor dem Ziel' if not reached else 'keiner')}",
        f"Antwort: {preview or '(keine Züge erkannt)'}",
    ]}}


def validate_request(req):
    """Prüft Raster, Start und Ziel. Gibt (walls, start, end) zurück, sonst ValueError."""
    walls = req.get("walls")
    if not walls or not all(isinstance(row, list) for row in walls):
        raise ValueError("Kein gültiges Raster übertragen.")
    h, w = len(walls), len(walls[0])
    if w == 0 or any(len(row) != w for row in walls):
        raise ValueError("Raster ist nicht rechteckig.")
    try:
        start, end = tuple(map(int, req["start"])), tuple(map(int, req["end"]))
    except (KeyError, TypeError, ValueError):
        raise ValueError("Start oder Ziel fehlt.")
    for name, (x, y) in (("Start", start), ("Ziel", end)):
        if not (0 <= x < w and 0 <= y < h):
            raise ValueError(f"{name} ({x}, {y}) liegt außerhalb des Rasters ({w}×{h}).")
        if walls[y][x]:
            raise ValueError(f"{name} ({x}, {y}) liegt auf einer Wand.")
    if start == end:
        raise ValueError("Start und Ziel sind dasselbe Feld.")
    return walls, start, end


# --------------------------------------------------------------------------- #
#  Webserver
# --------------------------------------------------------------------------- #
class Handler(SimpleHTTPRequestHandler):
    """Liefert ./web aus und beantwortet POST /llm und POST /llm/control."""
    llm = None

    def log_message(self, fmt, *args):
        pass

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_POST(self):
        if self.path == "/llm":
            self.handle_run()
        elif self.path == "/llm/control":
            self.handle_control()
        else:
            self.send_error(404)

    def emit(self, event, ctl):
        """Schickt ein Event als JSON-Zeile. Bricht den Lauf ab, wenn der Browser weg ist."""
        try:
            self.wfile.write((json.dumps(event) + "\n").encode())
            self.wfile.flush()
        except OSError:
            ctl.cancel()
            raise Cancelled()

    def handle_run(self):
        """Startet einen Lauf und streamt seine Events an den Browser."""
        try:
            req = self.read_json()
            walls, start, end = validate_request(req)
            temperature = float(req.get("temperature", 0.7))
            max_steps = max(1, min(int(req.get("max_steps", 300)), 2000))
            ctl = RunControl(float(req.get("delay_ms", 0)))
        except Exception as e:
            print(f"[/llm] Ungültige Anfrage: {e}")
            return self.send_json(400, {"error": str(e)})

        run_id = str(req.get("run") or id(self))
        with RUNS_LOCK:   # immer nur ein Lauf gleichzeitig
            for old in RUNS.values():
                old.cancel()
            RUNS[run_id] = ctl

        mode, thinking = req.get("mode"), bool(req.get("thinking"))
        view = max(0, min(int(req.get("view") or 0), 3))
        if mode == "oneshot":
            events = run_oneshot(self.llm, walls, start, end, temperature, max_steps, ctl)
        elif mode == "bestfirst":
            events = run_bestfirst(self.llm, walls, start, end, max_steps, ctl, thinking, view)
        else:
            mode = "step"
            events = run_step(self.llm, walls, start, end, bool(req.get("memory", True)),
                              temperature, max_steps, ctl, thinking, view)

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        ctl.ping = lambda: self.emit({"type": "ping"}, ctl)
        t0 = time.monotonic()
        try:
            self.emit({"type": "start", "mode": mode, "run": run_id}, ctl)
            for event in events:
                if ctl.cancelled.is_set():
                    raise Cancelled()
                self.emit(event, ctl)
            print(f"[/llm] {mode}: fertig nach {time.monotonic() - t0:.1f}s")
        except Cancelled:
            print(f"[/llm] {mode}: abgebrochen nach {time.monotonic() - t0:.1f}s")
        except Exception as e:
            traceback.print_exc()
            message = f"{type(e).__name__}: {e}"
            if "out of memory" in message:
                message += " – Raster verkleinern oder kleineres Modell verwenden."
            try:
                self.emit({"type": "error", "message": message}, ctl)
            except Cancelled:
                pass
        finally:
            with RUNS_LOCK:
                if RUNS.get(run_id) is ctl:
                    del RUNS[run_id]

    def handle_control(self):
        """Pause, Fortsetzen, Abbruch oder neues Tempo für einen laufenden Lauf."""
        req = self.read_json()
        with RUNS_LOCK:
            ctl = RUNS.get(str(req.get("run")))
        if ctl is None:
            return self.send_json(200, {"ok": False, "error": "Lauf nicht gefunden"})
        action = req.get("action")
        if action == "pause":
            ctl.running.clear()
        elif action == "resume":
            ctl.running.set()
        elif action == "cancel":
            ctl.cancel()
        elif action == "delay":
            ctl.delay = max(0.0, float(req.get("delay_ms", 0)) / 1000)
        else:
            return self.send_json(400, {"error": f"Unbekannte Aktion: {action}"})
        self.send_json(200, {"ok": True})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default=DEFAULT_MODEL, help="Hugging-Face-Modell-ID oder lokaler Ordner")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--mock", action="store_true", help="ohne Modell starten (nur Oberfläche testen)")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    Handler.llm = MockLLM() if args.mock else LLM(args.model)
    server = ThreadingHTTPServer(("127.0.0.1", args.port),
                                 functools.partial(Handler, directory=str(WEB_DIR)))
    server.daemon_threads = True
    url = f"http://localhost:{args.port}/"
    print(f"Läuft auf {url}  (Strg+C zum Beenden)")
    if not args.no_browser:
        webbrowser.open(url)
    server.serve_forever()


if __name__ == "__main__":
    main()
