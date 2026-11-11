// SPDX-License-Identifier: AGPL-3.0-only
package com.shilapi.xcertplay.web

import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Provisioned HTTPS identities ship as https_cert.zip; the extractor must find both PEM parts. */
class LanTlsBundledCertTest {
    private fun zip(vararg entries: Pair<String, String>): ByteArray =
        ByteArrayOutputStream().use { output ->
            ZipOutputStream(output).use { zip ->
                for ((name, content) in entries) {
                    zip.putNextEntry(ZipEntry(name))
                    zip.write(content.toByteArray())
                }
            }
            output.toByteArray()
        }

    @Test
    fun extractsChainAndKeyWhateverTheEntryPathsAre() {
        val (chain, key) =
            LanTls.parseBundled(
                zip(
                    "certs/sub/fullchain.pem" to "CHAIN",
                    "keys/privkey.pem" to "KEY",
                ),
            )!!
        assertEquals("CHAIN", chain.toString(Charsets.UTF_8))
        assertEquals("KEY", key.toString(Charsets.UTF_8))
    }

    @Test
    fun aZipWithoutBothPartsIsRejected() {
        assertNull(LanTls.parseBundled(zip("fullchain.pem" to "CHAIN")))
        assertNull(LanTls.parseBundled(zip("privkey.pem" to "KEY")))
        assertNull(LanTls.parseBundled(byteArrayOf()))
    }
}
