// Why built in: catalog grammars ship no sample, and an empty file shows no highlighting.
// Keyed by extension; a plugin's first listed extension with a sample wins.
const SYNTAX_SAMPLES: Readonly<Record<string, string>> = {
  '.gleam':
    'import gleam/io\n\n// Greets whoever runs it.\npub fn main() -> Nil {\n  let count = 3\n  io.println("Hello from Gleam!")\n}\n',
  '.prisma':
    '// A user table.\nmodel User {\n  id    Int     @id @default(autoincrement())\n  email String  @unique\n  name  String?\n}\n',
  '.nix':
    '{ pkgs ? import <nixpkgs> { } }:\n\n# A development shell.\npkgs.mkShell {\n  packages = [ pkgs.nodejs ];\n  shellHook = "echo ready";\n}\n',
  '.gd':
    'extends Node2D\n\n# Moves right every frame.\nvar speed := 120.0\n\nfunc _process(delta: float) -> void:\n\tposition.x += speed * delta\n',
  '.tex':
    '\\documentclass{article}\n\n% A tiny document.\n\\begin{document}\n\\section{Hello}\nInline math: $e^{i\\pi} + 1 = 0$.\n\\end{document}\n',
  '.vhd': `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- A 4-bit counter with synchronous reset.
entity counter is
  port (
    clk   : in  std_logic;
    reset : in  std_logic;
    count : out unsigned(3 downto 0)
  );
end entity counter;

architecture rtl of counter is
  signal value : unsigned(3 downto 0) := (others => '0');
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if reset = '1' then
        value <= (others => '0');
      else
        value <= value + 1;
      end if;
    end if;
  end process;
  count <= value;
end architecture rtl;
`,
  '.vcl': `vcl 4.1;

# Cache static assets for a day.
backend default {
    .host = "127.0.0.1";
    .port = "8080";
}

sub vcl_recv {
    if (req.method != "GET" && req.method != "HEAD") {
        return (pass);
    }
    if (req.url ~ "\\.(css|js|png|svg)$") {
        unset req.http.Cookie;
        return (hash);
    }
}

sub vcl_backend_response {
    if (bereq.url ~ "\\.(css|js|png|svg)$") {
        set beresp.ttl = 1d;
    }
}
`,
  '.qml': `import QtQuick
import QtQuick.Controls

// A counter with a button.
ApplicationWindow {
    id: window
    width: 640
    height: 480
    visible: true
    title: qsTr("Counter")

    property int count: 0

    Column {
        anchors.centerIn: parent
        spacing: 12

        Label {
            text: "Clicked " + window.count + " times"
            font.pixelSize: 24
        }

        Button {
            text: "Click me"
            onClicked: window.count += 1
        }
    }
}
`,
  '.tks': `# Monday
02/11/2026
backend        09:00-10:30  Review open pull requests
backend        10:30-12:15  Fix the nightly export job
meetings          1         Sprint planning
support           0.75      Answer customer questions

# Tuesday
03/11/2026
backend        09:15-11:45  Add retries to the billing webhook
`,
  '.http': `@baseUrl = https://api.example.com
@token = {{$dotenv API_TOKEN}}

### List open orders
GET {{baseUrl}}/orders?status=open&limit=20 HTTP/1.1
Accept: application/json
Authorization: Bearer {{token}}

### Create an order
POST {{baseUrl}}/orders HTTP/1.1
Content-Type: application/json

{
  "customer": "ada@example.com",
  "items": [{ "sku": "ORCA-1", "quantity": 2 }],
  "express": true
}
`,
  '.service': `# Runs the web app and restarts it on failure.
[Unit]
Description=Example web app
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=web
WorkingDirectory=/srv/web
Environment=PORT=8080 NODE_ENV=production
ExecStart=/usr/bin/node /srv/web/server.js
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
`,
  '.m': `% Fits a line to noisy data and plots it.
function fitDemo()
  x = linspace(0, 10, 50);
  y = 2.5 * x + 1 + randn(size(x));

  p = polyfit(x, y, 1);
  fprintf('slope = %.2f, intercept = %.2f\\n', p(1), p(2));

  if p(1) > 0
    disp('Trend is upward');
  end

  plot(x, y, 'o', x, polyval(p, x), '-');
  title('Linear fit');
end
`,
  '.ml': `(* Counts how often each word appears. *)
module StringMap = Map.Make (String)

let add_word counts word =
  StringMap.update word
    (function None -> Some 1 | Some n -> Some (n + 1))
    counts

let count_words lines =
  lines
  |> List.concat_map (String.split_on_char ' ')
  |> List.filter (fun word -> word <> "")
  |> List.fold_left add_word StringMap.empty

let () =
  count_words [ "the quick fox"; "the lazy dog" ]
  |> StringMap.iter (fun word n -> Printf.printf "%s: %d\\n" word n)
`,
  '.jl': `# Estimates pi by sampling points in a unit square.
using Random

struct Estimate
    samples::Int
    value::Float64
end

function estimate_pi(n::Int; rng = Random.default_rng())
    inside = count(_ -> rand(rng)^2 + rand(rng)^2 <= 1, 1:n)
    return Estimate(n, 4 * inside / n)
end

for n in (1_000, 100_000)
    e = estimate_pi(n)
    println("n = $(e.samples): pi is about $(round(e.value; digits = 4))")
end
`,
  '.hs': `module Main where

import Data.List (sortOn)
import qualified Data.Map.Strict as Map

-- | Counts how often each word appears.
wordFreq :: String -> Map.Map String Int
wordFreq = Map.fromListWith (+) . map (\\w -> (w, 1)) . words

main :: IO ()
main = do
  let text = "the quick brown fox jumps over the lazy dog the end"
      top = take 3 . sortOn (negate . snd) . Map.toList $ wordFreq text
  mapM_ (\\(w, n) -> putStrLn (w ++ ": " ++ show n)) top
`,
  '.erl': `%% A counter process that answers increments and reads.
-module(counter).
-export([start/0, increment/1, value/1]).

start() ->
    spawn(fun() -> loop(0) end).

increment(Pid) ->
    Pid ! {increment, 1},
    ok.

value(Pid) ->
    Pid ! {value, self()},
    receive
        {count, N} -> N
    after 1000 -> timeout
    end.

loop(N) ->
    receive
        {increment, By} -> loop(N + By);
        {value, From} -> From ! {count, N}, loop(N)
    end.
`,
  '.jsp': `<%@ page contentType="text/html; charset=UTF-8" %>
<%@ page import="java.time.LocalTime" %>
<%-- Greets the visitor by time of day. --%>
<html>
<body>
  <% int hour = LocalTime.now().getHour(); %>
  <h1>Good <%= hour < 12 ? "morning" : "afternoon" %>!</h1>
  <ul>
    <% for (String item : new String[] { "Orders", "Invoices", "Reports" }) { %>
      <li><a href="/<%= item.toLowerCase() %>"><%= item %></a></li>
    <% } %>
  </ul>
</body>
</html>
`
}

export function pluginSyntaxSample(
  syntaxes: readonly { extensions: readonly string[] }[]
): { extension: string; content: string } | null {
  for (const extension of syntaxes.flatMap((syntax) => syntax.extensions)) {
    const content = SYNTAX_SAMPLES[extension.toLowerCase()]
    if (content) {
      return { extension, content }
    }
  }
  return null
}
