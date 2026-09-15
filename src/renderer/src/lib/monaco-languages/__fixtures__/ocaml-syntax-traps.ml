(* Fixture for the OCaml TextMate grammar. Every construct here is one that a
   naive tokenizer gets wrong; see register-ocaml.test.ts for the assertions. *)

(* outer (* inner (* innermost *) still inner *) back to outer *)
(**)
(** A doc comment with {b markup} and [code]. *)

(** An unbalanced bracket in inline code must not leak tokenizer state.
    This is equivalent to [(]{!rev}[ l1) @ l2]. *)

(* Type variables must not open a character literal. *)
let id : 'a -> 'a = fun x -> x
let pair : 'a -> 'b -> 'a * 'b = fun a b -> (a, b)

(* Genuine character literals, only in closed forms. *)
let newline = '\n'
let backslash = '\\'
let quote = '\''
let decimal = '\065'
let hex = '\xFF'
let octal = '\o101'
let plain = 'x'

(* Strings: escapes, and a trailing backslash continuing the line. *)
let escaped = "tab\there \"quoted\" back\\slash \065 \xFF \o101"
let continued = "first half \
                 second half"

(* Quoted string literals. *)
let raw = {|no \n escapes here, and "quotes" are literal|}
let tagged = {sql|SELECT * FROM t WHERE name = 'x'|sql}
let nested_delim = {ext|contains |} which does not close it|ext}

(* Polymorphic variants. *)
type status = [ `Pending | `Done of int | `Failed of string ]

let describe = function
  | `Pending -> "pending"
  | `Done n -> string_of_int n
  | `Failed msg -> msg

(* Labelled and optional arguments. *)
let render ~label ?(width = 80) ?indent () =
  ignore indent;
  String.length label + width

let _ = render ~label:"x" ~width:10 ()

(* Capitalised identifiers: modules and constructors. *)
module Config = struct
  type t = { name : string; retries : int }

  let default = { name = "default"; retries = 3 }
end

exception Not_ready of string

let _ = List.map Config.(fun c -> c.name) []

(* Attributes and PPX extensions. *)
type person = { first : string; last : string } [@@deriving show, eq]

[@@@warning "-32"]

let unused = () [@warning "-26"]
let expanded = [%string "interpolated"]

[%%private let hidden = 1]

let%lwt result = Lwt.return 1

let run () =
  match%bind fetch () with
  | Ok v -> v
  | Error _ -> 0

(* Operators, including user-defined symbolic ones and keyword operators. *)
let ( +| ) a b = a + b + 1
let ( >>= ) x f = f x
let ( >>| ) x f = f x

let arithmetic = 1.5 +. 2.5 -. 0.5 *. 2.0 /. 4.0
let piped = [ 1; 2; 3 ] |> List.map succ |> List.rev
let applied = print_string @@ "x" ^ "y"
let bits = 5 land 3 lor 1 lxor 2 lsl 1 lsr 1 asr 1
let modulo = 7 mod 2
let consed = 1 :: 2 :: []
let compared = (1 <> 2) && (1 == 1) && (1 != 2)

let counter = ref 0
let () = counter := !counter + 1

type mutable_box = { mutable value : int }

let bump b = b.value <- b.value + 1

(* Numeric literals in every form. *)
let million = 1_000_000
let hexa = 0xDEAD_BEEF
let octa = 0o755
let bina = 0b1010_1010
let trailing_dot = 1.
let exponent = 1.5e-3
let hex_float = 0x1.8p3
let int32 = 42l
let int64 = 42L
let native = 42n

(* Structural keywords. *)
let rec loop' i acc = if i = 0 then acc else loop' (i - 1) (acc + i)

class virtual shape =
  object
    method virtual area : float
  end

let _ =
  begin
    for i = 0 to 10 do
      ignore i
    done;
    while false do
      ()
    done
  end

let _ =
  try Some (loop' 3 0) with
  | Not_ready _ -> None
