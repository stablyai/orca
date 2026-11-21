import { describe, expect, it } from 'vitest'
import {
  nativeChatTextWithoutUploadedFiles,
  nativeChatUploadedFilePaths
} from './native-chat-text-attachment-references'

const dir = '/home/u/.orca/agent-session-attachments/0b3f5c2a-1d4e-4a6b-9c8d-7e6f5a4b3c2d'

describe('uploaded file references in a sent message', () => {
  it('finds binary uploads as well as text ones and leaves other @mentions alone', () => {
    const text = `look @${dir}/movie.mov and @${dir}/notes.txt and @src/app.ts`
    expect(nativeChatUploadedFilePaths(text)).toEqual([`${dir}/movie.mov`, `${dir}/notes.txt`])
  })

  it('drops the upload tokens and keeps the message text', () => {
    expect(nativeChatTextWithoutUploadedFiles(`look @${dir}/movie.mov at this`)).toBe(
      'look  at this'
    )
    expect(nativeChatTextWithoutUploadedFiles(`@${dir}/a.zip @${dir}/b.pdf`)).toBe('')
  })

  it('finds the escaped plain path a terminal chat types for an upload', () => {
    const plain =
      '/Users/u/Library/Application\\ Support/orca/agent-session-attachments/0b3f5c2a-1d4e-4a6b-9c8d-7e6f5a4b3c2d/Screen\\ Recording\\ 1.mp4'
    const text = `${plain} Video uploading test`
    expect(nativeChatUploadedFilePaths(text)).toEqual([
      '/Users/u/Library/Application Support/orca/agent-session-attachments/0b3f5c2a-1d4e-4a6b-9c8d-7e6f5a4b3c2d/Screen Recording 1.mp4'
    ])
    expect(nativeChatTextWithoutUploadedFiles(text)).toBe('Video uploading test')
    expect(nativeChatUploadedFilePaths('see /Users/u/notes/todo.txt please')).toEqual([])
  })

  it('splits two plain upload paths a terminal chat ran together', () => {
    const base = '/Users/u/Library/Application\\ Support/orca/agent-session-attachments'
    const text = `${base}/0b3f5c2a-1d4e-4a6b-9c8d-7e6f5a4b3c2d/session.json${base}/1c4e6d3b-2e5f-4b7c-8d9e-8f7a6b5c4d3e/Bon\\ Jovi\\ \u2014\\ Song.rtf Multi file upload test`
    expect(nativeChatUploadedFilePaths(text)).toEqual([
      '/Users/u/Library/Application Support/orca/agent-session-attachments/0b3f5c2a-1d4e-4a6b-9c8d-7e6f5a4b3c2d/session.json',
      '/Users/u/Library/Application Support/orca/agent-session-attachments/1c4e6d3b-2e5f-4b7c-8d9e-8f7a6b5c4d3e/Bon Jovi \u2014 Song.rtf'
    ])
    expect(nativeChatTextWithoutUploadedFiles(text)).toBe('Multi file upload test')
  })

  it('keeps the drive letter of a Windows upload path', () => {
    const store = 'C:/Users/u/AppData/Roaming/orca/agent-session-attachments'
    const id = '0b3f5c2a-1d4e-4a6b-9c8d-7e6f5a4b3c2d'
    expect(nativeChatUploadedFilePaths(`${store}/${id}/movie.mp4 watch this`)).toEqual([
      `${store}/${id}/movie.mp4`
    ])
    const quoted = `@"C:\\Users\\u\\AppData\\Roaming\\orca\\agent-session-attachments\\${id}\\my notes.txt"`
    expect(nativeChatUploadedFilePaths(quoted)).toEqual([
      `C:\\Users\\u\\AppData\\Roaming\\orca\\agent-session-attachments\\${id}\\my notes.txt`
    ])
  })

  it('finds the plain backslash paths a Windows terminal chat types, quoted when they have a space', () => {
    const store = 'C:\\Users\\u\\AppData\\Roaming\\orca\\agent-session-attachments'
    const bare = `${store}\\0b3f5c2a-1d4e-4a6b-9c8d-7e6f5a4b3c2d\\movie.mp4`
    const spaced = `${store}\\1c4e6d3b-2e5f-4b7c-8d9e-8f7a6b5c4d3e\\My Notes.txt`
    const text = `${bare} "${spaced}" Files test`
    expect(nativeChatUploadedFilePaths(text)).toEqual([bare, spaced])
    expect(nativeChatTextWithoutUploadedFiles(text)).toBe('Files test')
    expect(nativeChatUploadedFilePaths('see C:\\Users\\u\\notes\\todo.txt please')).toEqual([])
  })
})
