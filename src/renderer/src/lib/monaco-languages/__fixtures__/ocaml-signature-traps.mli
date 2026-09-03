(** Fixture for signature files, which tokenize under `source.ocaml`. Every
    declaration here is one that grammar reaches only through its transitive
    include of `source.ocaml.interface#bindings`. *)

type t

type 'a result = Ok of 'a | Error of string

val empty : t

val add : key:string -> data:int -> t -> t

val find_opt : string -> t -> int option

val fold : (string -> int -> 'acc -> 'acc) -> t -> 'acc -> 'acc

external identity : 'a -> 'a = "%identity"

exception Not_found_in of string

module type ORDERED = sig
  type key

  val compare : key -> key -> int
end

module Make (Ord : ORDERED) : sig
  type nonrec t

  val singleton : Ord.key -> t
end

class type printable = object
  method to_string : string
end

(** A doc comment at the end of a signature must close cleanly. *)
