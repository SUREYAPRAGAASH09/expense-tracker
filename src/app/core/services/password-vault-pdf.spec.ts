import pdfMake from 'pdfmake/build/pdfmake.js';
import pdfFonts from 'pdfmake/build/vfs_fonts.js';

describe('password backup PDF encryption', () => {
  it('generates AES-256 encrypted PDF bytes without leaving a plaintext password string', async () => {
    pdfMake.addVirtualFileSystem(pdfFonts);
    const secret = 'very-private-site-password-982';
    const pdf = await pdfMake.createPdf({
      version: '1.7ext3',
      userPassword: 'manager-password-very-strong',
      content: [{ text: `example.com ${secret}` }],
    }).getBuffer();

    const pdfText = new TextDecoder('latin1').decode(pdf);
    expect(pdfText.startsWith('%PDF-')).toBe(true);
    expect(pdfText).toContain('/Encrypt');
    expect(pdfText).toContain('/AESV3');
    expect(pdfText).not.toContain(secret);
  });
});
