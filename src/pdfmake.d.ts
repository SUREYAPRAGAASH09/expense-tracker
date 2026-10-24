declare module 'pdfmake/build/pdfmake.js' {
  const pdfMake: {
    addVirtualFileSystem(files: unknown): void;
    createPdf(definition: unknown): {
      download(filename?: string): void;
      getBuffer(): Promise<Uint8Array>;
    };
  };
  export default pdfMake;
}

declare module 'pdfmake/build/vfs_fonts.js' {
  const fonts: unknown;
  export default fonts;
}
